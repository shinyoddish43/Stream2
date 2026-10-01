// Twitch chat, read only. The browser joins the channel's chat the way Twitch's
// own signed-out viewers do: no account, no key, and nothing is ever sent to
// the chat. Each message is handed to the page as it arrives.

export const CHAT_URL = 'wss://irc-ws.chat.twitch.tv:443';
const EMOTES = 'https://static-cdn.jtvnw.net/emoticons/v2';
// Quiet channels still get a PING from Twitch about every five minutes;
// hearing nothing for longer means the connection died without saying so.
const SILENCE_MS = 7 * 60e3;
// The colours Twitch gives names whose owners never picked one.
const NAME_COLORS = ['#ff0000', '#0000ff', '#008000', '#b22222', '#ff7f50', '#9acd32', '#ff4500', '#2e8b57',
  '#daa520', '#d2691e', '#5f9ea0', '#1e90ff', '#ff69b4', '#8a2be2', '#00ff7f'];
const PANEL = [0x1f, 0x22, 0x27];   // --panel in app.css, what names are read against

/**
 * A channel as people paste it ("Name", "#name", "twitch.tv/name", the full
 * address) as Twitch's login for it, or '' if it cannot be one.
 */
export function channelName(input) {
  const name = String(input || '').trim()
    .replace(/^(https?:\/\/)?((www|m)\.)?twitch\.tv\//i, '')
    .replace(/^[#@]/, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(name) ? name : '';
}

const TAG_ESCAPES = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };

/** One IRC line: { tags, prefix, nick, command, params }. */
export function parseIrc(line) {
  const msg = { tags: {}, prefix: '', nick: '', command: '', params: [] };
  let rest = String(line);
  const word = () => {
    rest = rest.replace(/^ +/, '');
    const i = rest.indexOf(' ');
    const w = i < 0 ? rest : rest.slice(0, i);
    rest = i < 0 ? '' : rest.slice(i + 1);
    return w;
  };
  if (rest.startsWith('@')) {
    for (const pair of word().slice(1).split(';')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) { msg.tags[pair] = ''; continue; }
      msg.tags[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/\\(.?)/g, (_, c) => TAG_ESCAPES[c] ?? c);
    }
  }
  if (rest.replace(/^ +/, '').startsWith(':')) {
    msg.prefix = word().slice(1);
    msg.nick = msg.prefix.split('!')[0].split('@')[0];
  }
  msg.command = word().toUpperCase();
  while (rest.replace(/^ +/, '')) {
    rest = rest.replace(/^ +/, '');
    if (rest.startsWith(':')) { msg.params.push(rest.slice(1)); break; }
    msg.params.push(word());
  }
  return msg;
}

/**
 * A message cut into text and emotes. Twitch gives emote positions as
 * "id:start-end,start-end/id:start-end", counting characters (code points),
 * not the UTF-16 units JavaScript strings index by.
 */
export function messageParts(text, emotes = '') {
  const chars = Array.from(String(text));
  const spans = [];
  for (const group of String(emotes || '').split('/')) {
    const [id, ranges] = group.split(':');
    if (!/^[A-Za-z0-9_]+$/.test(id || '') || !ranges) continue;
    for (const range of ranges.split(',')) {
      const [a, b] = range.split('-').map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= b && b < chars.length) spans.push({ a, b, id });
    }
  }
  spans.sort((x, y) => x.a - y.a);
  const parts = [];
  let at = 0;
  for (const { a, b, id } of spans) {
    if (a < at) continue;               // overlaps the one before: keep that one
    if (a > at) parts.push({ text: chars.slice(at, a).join('') });
    parts.push({ emote: id, name: chars.slice(a, b + 1).join('') });
    at = b + 1;
  }
  if (at < chars.length) parts.push({ text: chars.slice(at).join('') });
  return parts;
}

export const emoteUrl = (id, scale = '1.0') => `${EMOTES}/${encodeURIComponent(id)}/default/dark/${scale}`;

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x, y) => { const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * The colour a name is shown in: the one its owner picked, or Twitch's default
 * for that name, lightened until it reads on the dark panel. Pure blue on
 * near-black is what many people pick, and it is unreadable as it is.
 */
export function nameColor(color, login = '') {
  let hex = /^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : null;
  if (!hex) {
    let h = 0;
    for (const ch of String(login)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    hex = NAME_COLORS[h % NAME_COLORS.length];
  }
  let rgb = toRgb(hex);
  // Mix towards white a step at a time: the hue stays, the text gets readable.
  for (let i = 0; i < 20 && contrast(rgb, PANEL) < 4.5; i++) rgb = rgb.map((v) => v + (255 - v) * 0.12);
  return toHex(rgb);
}

/** A chat message (PRIVMSG) as the page shows it. */
export function chatMessage(msg) {
  const tags = msg.tags;
  let text = msg.params[1] || '';
  // "/me waves" arrives as \x01ACTION waves\x01; emote positions count from "waves".
  const action = /^\x01ACTION (.*?)\x01?$/s.exec(text);
  if (action) text = action[1];
  const login = msg.nick;
  const display = (tags['display-name'] || '').trim() || login;
  return {
    id: tags.id || '',
    login,
    // Names in other scripts ("홍길동") also show the login people @ them by.
    name: display.toLowerCase() === login ? display : `${display} (${login})`,
    color: nameColor(tags.color, login),
    action: !!action,
    parts: messageParts(text, tags.emotes),
    text,
    // "set/version", as Twitch's badge lists name them: moderator/1, subscriber/12.
    badges: (tags.badges || '').split(',').filter((b) => /^[\w-]+\/[\w-]+$/.test(b)),
    first: tags['first-msg'] === '1',
    bits: Number(tags.bits) || 0,
    time: Number(tags['tmi-sent-ts']) || Date.now(),
  };
}

/**
 * The connection. `on(event)` hears:
 *   { type: 'state', state: 'connecting' | 'joined' | 'missing' | 'waiting' | 'off', seconds? }
 *     ('missing': Twitch has no such channel. It never says so, it just stays silent.)
 *   { type: 'message', message }           a chat message, see chatMessage()
 *   { type: 'notice', text, message? }     subs, raids, announcements, Twitch notices
 *   { type: 'clear', login? }              a moderator cleared the chat, or one person's messages
 *   { type: 'delete', id }                 a moderator deleted one message
 * It reconnects by itself, waiting a little longer each time, up to 30 s.
 */
export class TwitchChat {
  constructor({ on = () => {}, url = CHAT_URL, WebSocket: Socket = globalThis.WebSocket, delay, joinWait = 10000 } = {}) {
    this.on = on;
    this.url = url;
    this.Socket = Socket;
    this.delay = delay || ((tries) => Math.min(30000, 1000 * 2 ** tries));
    this.joinWait = joinWait;
    this.channel = '';
    this.ws = null;
    this.tries = 0;
    this.timer = null;
    this.silence = null;
    this.joining = null;
  }

  /** Show `channel`'s chat; '' leaves it. */
  join(channel) {
    channel = channelName(channel);
    if (channel === this.channel && (this.ws || this.timer)) return;
    this.channel = channel;
    this.tries = 0;
    this.drop();
    if (channel) this.connect();
    else this.on({ type: 'state', state: 'off' });
  }

  close() { this.join(''); }

  connect() {
    clearTimeout(this.timer);
    this.timer = null;
    const channel = this.channel;
    let ws;
    try { ws = new this.Socket(this.url); } catch { this.retry(); return; }
    this.ws = ws;
    this.on({ type: 'state', state: 'connecting' });
    const send = (line) => { if (ws.readyState === 1) ws.send(line); };
    ws.onopen = () => {
      send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      send('PASS SCHMOOPIIE');                                   // any password: signed-out viewers send one too
      send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`);
      send(`JOIN #${channel}`);
      this.listen(ws);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.listen(ws);
      for (const line of String(e.data).split('\r\n')) if (line) this.handle(parseIrc(line), send, ws);
    };
    // Browsers follow an error with a close; some WebSocket implementations
    // only report the error. Either one means: try again in a while.
    ws.onclose = ws.onerror = () => { if (this.ws === ws) { this.drop(); this.retry(); } };
  }

  // A connection that goes quiet for too long is replaced.
  listen(ws) {
    clearTimeout(this.silence);
    this.silence = setTimeout(() => { if (this.ws === ws) { this.drop(); this.retry(); } }, SILENCE_MS);
  }

  handle(msg, send, ws) {
    const here = msg.params[0] === `#${this.channel}`;
    switch (msg.command) {
      case 'PING': send(`PONG :${msg.params[0] || 'tmi.twitch.tv'}`); break;
      // Signed in. A channel that exists answers the JOIN with its ROOMSTATE
      // within a moment, even when it is offline.
      case '001':
        clearTimeout(this.joining);
        this.joining = setTimeout(() => { if (this.ws === ws) this.on({ type: 'state', state: 'missing' }); }, this.joinWait);
        break;
      // Twitch is about to restart that server: go to another one now.
      case 'RECONNECT': this.drop(); this.tries = 0; this.connect(); break;
      case 'ROOMSTATE':
        if (here) { clearTimeout(this.joining); this.tries = 0; this.on({ type: 'state', state: 'joined' }); }
        break;
      case 'PRIVMSG':
        if (here) this.on({ type: 'message', message: chatMessage(msg) });
        break;
      case 'USERNOTICE':
        if (here) {
          this.on({
            type: 'notice',
            text: msg.tags['system-msg'] || '',
            message: msg.params[1] ? chatMessage({ ...msg, nick: msg.tags.login || msg.nick }) : null,
          });
        }
        break;
      case 'CLEARCHAT':
        if (here) this.on({ type: 'clear', login: msg.params[1] || null });
        break;
      case 'CLEARMSG':
        if (here && msg.tags['target-msg-id']) this.on({ type: 'delete', id: msg.tags['target-msg-id'] });
        break;
      case 'NOTICE':
        if (here || msg.params[0] === '*') this.on({ type: 'notice', text: msg.params[1] || '' });
        // "This channel does not exist or has been suspended": nothing will come.
        if (msg.tags['msg-id'] === 'msg_channel_suspended' && this.ws === ws) { this.drop(); this.on({ type: 'state', state: 'off' }); }
        break;
      default: break;
    }
  }

  retry() {
    if (!this.channel) return;
    const wait = this.delay(this.tries++);
    this.on({ type: 'state', state: 'waiting', seconds: Math.round(wait / 1000) });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  drop() {
    clearTimeout(this.timer);
    clearTimeout(this.silence);
    clearTimeout(this.joining);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
  }
}
