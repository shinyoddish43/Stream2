# Going live

Three ways to get the studio onto a real host, and one page that tells you
whether it worked.

---

## The check that matters

Whatever route you take, finish here:

```
https://your-domain/studio/health.php
```

It reports, in order of how much it will ruin your day:

| Check | Why it matters |
| --- | --- |
| **Data directory not public** | Your hashed password and encrypted stream keys live there. If the host serves it, fix that before anything else. |
| **HTTPS** | Screen capture, cameras and microphones do not start without it. |
| **Data directory writable** | Otherwise nothing saves. |
| **Extensions** | `xml` reads and writes your `.lss` splits. |
| **Installer removed / .git not published** | Tidiness that is also exposure. |
| **Relay reachable** | Only if you configured one. |

It needs a login once the studio is installed, because the answers describe
your server. `health.php?format=json` is the same thing for a script:

```bash
deploy/deploy.sh --check https://your-domain/studio
```

---

## 1. Upload a zip (simplest)

```bash
deploy/deploy.sh --zip
```

Gives you `stream-studio-deploy.zip` with the web files only — no tests, no
relay, no `.git`, and never your `data/`. In cPanel: File Manager → Upload →
Extract → open `install.php` → delete `install.php`.

## 2. cPanel Git Version Control (deploy by pushing)

The repository carries a `.cpanel.yml`. Edit one line in it:

```yaml
- export DEPLOYPATH=/home/YOURUSER/public_html/studio
```

Then in cPanel → **Git™ Version Control** → Create → point it at your
repository → **Manage** → **Pull or Deploy** → **Deploy HEAD Commit**.

The tasks copy the app, create `data/` if it is missing, re-write the deny
rules in case dotfiles were stripped, and remove `tests/`, `relay/`, `bridge/`
and `.github/` from the web root. It never touches `data/`, so your scenes,
splits and keys survive every deploy.

## 3. rsync over SSH

```bash
deploy/deploy.sh user@host:/home/user/public_html/studio
```

Shows you a dry run first and asks before sending anything.

## 4. GitHub Actions

`.github/workflows/deploy.yml`, run manually from the Actions tab — pushing a
branch should not change what your viewers are looking at.

It lints, runs every test that does not need a browser, stages the web files,
then uploads over **FTPS** (`FTP_HOST`, `FTP_USER`, `FTP_PASSWORD`, `FTP_PATH`)
or **SSH** (`SSH_PRIVATE_KEY`, `SSH_TARGET`, `SSH_KNOWN_HOSTS`), and finally
calls `health.php` on the URL you give it.

`data/` is excluded from both transfers.

---

## Before you call it live

- [ ] `health.php` is all green.
- [ ] `install.php` deleted.
- [ ] HTTPS forced on the domain (cPanel → Domains → Force HTTPS Redirect).
- [ ] Logged in and added one display capture — the browser prompts, which
      means HTTPS is really on.
- [ ] Pressed **Start recording**, stopped, opened the file.
- [ ] Destinations saved, and `curl https://your-domain/studio/data/config.json`
      returns 403 or 404 — never JSON.
- [ ] Overlay links (Overlays in the menu bar) open in a second browser.
- [ ] Rotated the overlay token if you pasted a link anywhere public.

## Updating a live install

Deploy again by whichever route you used. `data/` is excluded everywhere on
purpose, so an update never overwrites your scenes, splits or keys. Take a
backup first anyway — Settings → Account → **Export scene collection**, and
copy `data/` off the server.

## What does not belong on a web host

`relay/` and `bridge/` are not web files. The relay runs wherever Node and
ffmpeg live (a VPS, a box at home, or cPanel's "Setup Node.js App" outside the
web root). The bridge runs on the PC with LiveSplit on it. Every deploy route
here leaves both out of the web root.
