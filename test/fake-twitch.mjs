// A stand-in for Twitch's sign-in and API servers (id.twitch.tv/oauth2 and
// api.twitch.tv/helix), with the parts the chat uses. The test steers it:
// approve or decline a sign-in, expire a token, drop a message.
import http from 'node:http';

export const CLIENT_ID = 'abcdefghij0123456789klmnop';
export const CDN = 'https://static-cdn.jtvnw.net';

export async function fakeTwitch() {
  const t = {
    user: { id: '123456', login: 'oddish', display_name: 'Oddish' },
    pending: true,          // the device sign-in waits for the owner...
    decline: false,         // ...or the owner says no
    access: null,           // the one access token that works now
    refresh: null,          // and the refresh token that goes with it
    serial: 0,
    revoked: [],
    sent: [],               // chat messages, as Twitch received them
    drop: null,             // { code, message }: the next message is dropped with it
    refreshFails: false,
    expiresIn: 14000,       // what /validate says is left of the token
    validateFails: false,
    scopes: ['user:write:chat', 'channel:manage:broadcast', 'channel:read:stream_key'],
    streamKey: 'live_123456_fromtwitchKEY0123',
    channel: { title: 'Any% practice', game_id: '1', game_name: 'Super Metroid' },
    patches: [],            // what the studio asked Twitch to change on the channel
    games: [
      { id: '1', name: 'Super Metroid' }, { id: '2', name: 'Metroid Prime' }, { id: '3', name: 'Super Mario 64' },
      { id: '509658', name: 'Just Chatting' }, { id: '4', name: 'Metroid' }, { id: '5', name: 'Metroid Dread' },
    ],
    calls: [],
  };
  const issue = () => {
    t.serial++;
    t.access = `access-${t.serial}`;
    t.refresh = `refresh-${t.serial}`;
    return { access_token: t.access, refresh_token: t.refresh, expires_in: 14400, scope: ['user:write:chat'], token_type: 'bearer' };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://twitch');
      const form = new URLSearchParams(body);
      t.calls.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const bearer = (req.headers.authorization || '').replace(/^(Bearer|OAuth) /, '');
      const apiOk = bearer && bearer === t.access && req.headers['client-id'] === CLIENT_ID;
      switch (`${req.method} ${url.pathname}`) {
        case 'POST /oauth2/device':
          if (form.get('client_id') !== CLIENT_ID) return json(400, { status: 400, message: 'invalid client' });
          return json(200, { device_code: 'device-1', expires_in: 1800, interval: 0.2, user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' });
        case 'POST /oauth2/token':
          if (form.get('client_id') !== CLIENT_ID) return json(400, { status: 400, message: 'invalid client' });
          if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
            if (t.decline) return json(400, { status: 400, message: 'authorization_denied' });
            if (t.pending) return json(400, { status: 400, message: 'authorization_pending' });
            return json(200, issue());
          }
          if (form.get('grant_type') === 'refresh_token') {
            if (t.refreshFails || form.get('refresh_token') !== t.refresh) return json(400, { status: 400, message: 'Invalid refresh token' });
            return json(200, issue());
          }
          return json(400, { status: 400, message: 'unsupported grant type' });
        case 'GET /oauth2/validate':
          if (t.validateFails || !bearer || bearer !== t.access) return json(401, { status: 401, message: 'invalid access token' });
          return json(200, { client_id: CLIENT_ID, login: t.user.login, scopes: t.scopes, user_id: t.user.id, expires_in: t.expiresIn });
        case 'POST /oauth2/revoke':
          t.revoked.push(form.get('token'));
          return json(200, {});
        case 'GET /helix/users':
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          return json(200, { data: [{ id: t.user.id, login: t.user.login, display_name: t.user.display_name }] });
        case 'GET /helix/chat/emotes/global':
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          return json(200, { data: [{ id: '25', name: 'Kappa' }, { id: 'emotesv2_global1', name: 'GlobalHype' }, { id: '../x', name: 'Bad' }], template: `${CDN}/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}` });
        case 'GET /helix/chat/badges/global':
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          return json(200, { data: [
            { set_id: 'moderator', versions: [{ id: '1', title: 'Moderator', image_url_1x: `${CDN}/badges/v1/mod/1`, image_url_2x: `${CDN}/badges/v1/mod/2` }] },
            { set_id: 'subscriber', versions: [{ id: '0', title: 'Subscriber', image_url_1x: `${CDN}/badges/v1/globalsub/1`, image_url_2x: `${CDN}/badges/v1/globalsub/2` }] },
            { set_id: 'evil', versions: [{ id: '1', title: 'Evil', image_url_1x: 'https://evil.example/badge.png' }] },
          ] });
        case 'GET /helix/chat/badges':
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          if (url.searchParams.get('broadcaster_id') !== t.user.id) return json(200, { data: [] });
          return json(200, { data: [{ set_id: 'subscriber', versions: [{ id: '0', title: 'Oddish Subscriber', image_url_1x: `${CDN}/badges/v1/oddishsub/1`, image_url_2x: `${CDN}/badges/v1/oddishsub/2` }] }] });
        case 'GET /helix/streams/key':
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          if (!t.scopes.includes('channel:read:stream_key')) return json(401, { status: 401, message: 'Missing scope: channel:read:stream_key' });
          if (url.searchParams.get('broadcaster_id') !== t.user.id) return json(403, { status: 403, message: 'not your channel' });
          return json(200, { data: [{ stream_key: t.streamKey }] });
        case 'GET /helix/channels':
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          return json(200, { data: [{ broadcaster_id: t.user.id, broadcaster_login: t.user.login, ...t.channel }] });
        case 'PATCH /helix/channels': {
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          if (!t.scopes.includes('channel:manage:broadcast')) return json(401, { status: 401, message: 'Missing scope: channel:manage:broadcast' });
          const change = JSON.parse(body || '{}');
          t.patches.push({ broadcaster: url.searchParams.get('broadcaster_id'), ...change });
          if (change.title) t.channel.title = change.title;
          if (change.game_id) {
            const game = t.games.find((g) => g.id === change.game_id);
            if (!game) return json(400, { status: 400, message: 'Invalid game_id' });
            Object.assign(t.channel, { game_id: game.id, game_name: game.name });
          }
          res.writeHead(204);
          return res.end();
        }
        case 'GET /helix/search/categories': {
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          const q = (url.searchParams.get('query') || '').toLowerCase();
          t.searches = (t.searches || 0) + 1;
          return json(200, { data: t.games.filter((g) => g.name.toLowerCase().includes(q)).slice(0, Number(url.searchParams.get('first')) || 20).map((g) => ({ ...g, box_art_url: `${CDN}/ttv-boxart/${g.id}-{width}x{height}.jpg` })) });
        }
        case 'GET /helix/games': {
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          return json(200, { data: t.games.filter((g) => g.id === url.searchParams.get('id')) });
        }
        case 'POST /helix/chat/messages': {
          if (!apiOk) return json(401, { status: 401, message: 'Invalid OAuth token' });
          const msg = JSON.parse(body || '{}');
          if (t.drop) { const drop = t.drop; t.drop = null; return json(200, { data: [{ message_id: '', is_sent: false, drop_reason: drop }] }); }
          t.sent.push(msg);
          return json(200, { data: [{ message_id: `m${t.sent.length}`, is_sent: true }] });
        }
        default:
          return json(404, { status: 404, message: 'not found' });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.env = { TWITCH_AUTH_URL: `${base}/oauth2`, TWITCH_API_URL: `${base}/helix` };
  /** Make the current access token stop working, as if four hours went by. */
  t.expire = () => { t.access = `expired-${t.serial}`; };
  t.close = () => server.close();
  return t;
}
