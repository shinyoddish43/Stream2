"""Stream Studio on the six7 hub: the authentik side.

Runs inside the authentik container. On its own it only reports what it would
change; APPLY=1 makes the changes (all or nothing); APPLY=1 UNDO=1 removes them.

  docker exec six7-identity-1 ak shell -c "$(cat deploy/docker/authentik_setup.py)"
  docker exec -e APPLY=1 six7-identity-1 ak shell -c "$(cat deploy/docker/authentik_setup.py)"

It creates a forward-auth proxy provider and application for STUDIO_URL, open
to OWNER_GROUP only and answered by the embedded outpost, which is what the
hub Caddy's forward_auth asks. Settings (environment): STUDIO_URL, LOGIN_URL,
OWNER_GROUP.
"""
import os
import sys

from django.db import transaction

from authentik.core.models import Application, Group
from authentik.flows.models import Flow
from authentik.outposts.models import Outpost
from authentik.policies.models import PolicyBinding
from authentik.providers.proxy.models import ProxyMode, ProxyProvider

APPLY = os.environ.get("APPLY") == "1"
UNDO = os.environ.get("UNDO") == "1"
STUDIO_URL = os.environ.get("STUDIO_URL", "https://t.six7.pw").rstrip("/")
LOGIN_URL = os.environ.get("LOGIN_URL", "https://login.six7.pw/")
OWNER_GROUP = os.environ.get("OWNER_GROUP", "six7-owner")

PROVIDER = "Stream Studio"
APP_SLUG = "stream-studio"
EMBEDDED = "goauthentik.io/outposts/embedded"


def stop(message):
    print("STOPPED:", message)
    sys.exit(1)


def say(message):
    print(("  " if APPLY else "  would: ") + message)


owner = Group.objects.filter(name=OWNER_GROUP).first()
if owner is None:
    stop(f"no group {OWNER_GROUP}")
outpost = Outpost.objects.filter(managed=EMBEDDED).first()
if outpost is None:
    stop("no embedded outpost")
print(f"studio: {STUDIO_URL}; owner group: {OWNER_GROUP}; " + ("undoing:" if UNDO else "changes:"))


def undo():
    app = Application.objects.filter(slug=APP_SLUG).first()
    if app:
        say(f"delete application {APP_SLUG}")
        if APPLY:
            app.delete()
    provider = ProxyProvider.objects.filter(name=PROVIDER).first()
    if provider:
        say(f"delete provider {PROVIDER} and take it off the embedded outpost")
        if APPLY:
            outpost.providers.remove(provider)
            provider.delete()


def setup():
    authz = Flow.objects.get(slug="default-provider-authorization-implicit-consent")
    invalidation = Flow.objects.get(slug="default-provider-invalidation-flow")
    provider = ProxyProvider.objects.filter(name=PROVIDER).first()
    say(("update" if provider else "create") + f" forward-auth provider {PROVIDER} for {STUDIO_URL}")
    if APPLY:
        provider, _ = ProxyProvider.objects.update_or_create(name=PROVIDER, defaults={
            "authorization_flow": authz,
            "invalidation_flow": invalidation,
            "mode": ProxyMode.FORWARD_SINGLE,
            "external_host": STUDIO_URL,
            "access_token_validity": "days=30",
        })
        # What authentik's own API does on create: the callback redirect URI,
        # grant types and scope mappings. Without it sign-in fails with a
        # redirect URI error until authentik next restarts.
        provider.set_oauth_defaults()
        provider.save()
        print(f"    redirect URIs: {[u.url for u in provider.redirect_uris]}; grants: {provider.grant_types}")
    app = Application.objects.filter(slug=APP_SLUG).first()
    say(("update" if app else "create") + f" application {APP_SLUG}, launch URL {STUDIO_URL}/")
    if APPLY:
        app, _ = Application.objects.update_or_create(slug=APP_SLUG, defaults={
            "name": PROVIDER, "provider": provider, "meta_launch_url": STUDIO_URL + "/",
        })
    if not (app and PolicyBinding.objects.filter(target=app, group=owner).exists()):
        say(f"allow only group {OWNER_GROUP} into {APP_SLUG}")
        if APPLY:
            PolicyBinding.objects.create(target=app, group=owner, order=0)
    if not (provider and outpost.providers.filter(pk=provider.pk).exists()):
        say("serve the provider from the embedded outpost")
        if APPLY:
            outpost.providers.add(provider)
    config = outpost.config
    if not config.authentik_host:
        say(f"set the embedded outpost's authentik host to {LOGIN_URL}")
        if APPLY:
            config.authentik_host = LOGIN_URL
            outpost.config = config
            outpost.save()


with transaction.atomic():
    undo() if UNDO else setup()
print("done." if APPLY else "nothing changed (dry run). Rerun with APPLY=1 to make these changes.")
