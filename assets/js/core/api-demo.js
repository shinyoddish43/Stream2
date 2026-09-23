// Demo mode: the same API surface, backed by this browser instead of a server.
//
// It exists so the studio can be published as a plain static page — no PHP, no
// account, nothing to install — for trying the interface out. Everything is
// kept in localStorage, so it is per-browser and goes away when the browser
// data does. Anything that genuinely needs a server (stream keys, the relay
// ticket, changing a password) says so rather than pretending.

const KEY = 'streamstudio.demo.';

const read = (name, fallback) => {
  try {
    const raw = localStorage.getItem(KEY + name);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
};

const write = (name, value) => {
  try { localStorage.setItem(KEY + name, JSON.stringify(value)); } catch (e) { /* private mode */ }
  return value;
};

const fail = (message) => { throw new Error(message); };

// Overlay pages opened from a demo follow the timer over this channel; there
// is no server to poll.
let channel = null;
try { channel = new BroadcastChannel('streamstudio-timer'); } catch (e) {}

export const demoApi = {
  health: async () => ({ ok: true, app: 'stream-studio', demo: true, installed: true }),
  me: async () => ({ ok: true, installed: true, user: 'demo', csrf: 'demo', overlayToken: 'demo' }),
  logout: async () => ({ ok: true }),

  loadConfig: async () => ({ ok: true, config: read('config', null), rev: read('rev', 0) }),
  saveConfig: async (config) => {
    write('config', config);
    return { ok: true, rev: write('rev', (read('rev', 0) | 0) + 1) };
  },

  publishState: async (state) => {
    write('state', state);
    if (channel) { try { channel.postMessage(state); } catch (e) {} }
    return { ok: true, rev: 0 };
  },
  readState: async () => ({ ok: true, state: read('state', { rev: 0 }), rev: 0 }),

  listSplits: async () => ({ ok: true, splits: Object.values(read('splits', {})).map(summarise) }),
  getSplits: async (id) => {
    const run = read('splits', {})[id];
    return run ? { ok: true, run } : fail('those splits are not in this browser');
  },
  saveSplits: async (run) => {
    const all = read('splits', {});
    const id = run.id || 'sp_' + Math.random().toString(36).slice(2, 10);
    all[id] = { ...run, id, updatedAt: new Date().toISOString() };
    write('splits', all);
    return { ok: true, id };
  },
  deleteSplits: async (id) => {
    const all = read('splits', {});
    delete all[id];
    write('splits', all);
    return { ok: true };
  },
  importLss: async () => fail('demo mode parses .lss in the browser'),
  exportUrl: () => '#',

  listRuns: async () => ({ ok: true, runs: read('runs', []).slice().reverse() }),
  addRun: async (run) => {
    write('runs', read('runs', []).concat([{ ...run, at: new Date().toISOString() }]).slice(-200));
    return { ok: true };
  },

  getDestinations: async () => ({ ok: true, destinations: [] }),
  saveDestinations: async () => fail('stream keys need the real install — a demo page has nowhere safe to keep them'),
  relayTicket: async () => fail('streaming needs the real install and a relay; recording works here'),

  getSettings: async () => ({ ok: true, settings: { relay_url: '', overlay_token: 'demo', site_name: 'Stream Studio (demo)' } }),
  saveSettings: async () => ({ ok: true, overlay_token: 'demo' }),
  changePassword: async () => fail('there are no accounts in demo mode'),
};

function summarise(run) {
  return {
    id: run.id,
    game: run.game || '',
    category: run.category || '',
    segments: (run.segments || []).length,
    attempts: run.attempts || 0,
    pb: run.pbTime ?? null,
    updatedAt: run.updatedAt,
  };
}

export const isDemo = () => !!(typeof window !== 'undefined' && window.STUDIO_BOOT && window.STUDIO_BOOT.demo);
