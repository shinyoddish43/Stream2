// Thin wrapper over the PHP API. Adds the CSRF header and unwraps errors.

const BASE = 'api/index.php?r=';
let csrf = (window.STUDIO_BOOT && window.STUDIO_BOOT.csrf) || '';

export function setCsrf(token) { csrf = token || ''; }

async function request(route, { method = 'GET', body, raw = false, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(BASE + route, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (raw) return res;
  let data;
  try { data = await res.json(); } catch (e) { throw new Error(`bad response from server (${res.status})`); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

export const api = {
  health: () => request('health'),
  me: () => request('session/me'),
  logout: () => request('session/logout', { method: 'POST' }),

  loadConfig: () => request('config'),
  saveConfig: (config) => request('config', { method: 'POST', body: { config } }),

  publishState: (state) => request('state', { method: 'POST', body: { state } }),
  readState: (since, wait) => request(`state&since=${since | 0}${wait ? '&wait=' + wait : ''}`),

  listSplits: () => request('splits/list'),
  getSplits: (id) => request('splits/get&id=' + encodeURIComponent(id)),
  saveSplits: (run) => request('splits/save', { method: 'POST', body: { run } }),
  deleteSplits: (id) => request('splits/delete', { method: 'POST', body: { id } }),
  importLss: (xml) => request('splits/import', { method: 'POST', body: { xml } }),
  exportUrl: (id) => BASE + 'splits/export&id=' + encodeURIComponent(id),

  listRuns: () => request('runs/list'),
  addRun: (run) => request('runs/add', { method: 'POST', body: { run } }),

  getDestinations: () => request('destinations'),
  saveDestinations: (destinations) => request('destinations', { method: 'POST', body: { destinations } }),
  relayTicket: (opts) => request('relay/ticket', { method: 'POST', body: opts || {} }),

  getSettings: () => request('settings'),
  saveSettings: (settings) => request('settings', { method: 'POST', body: settings }),
  changePassword: (current, next) => request('password', { method: 'POST', body: { current, next } }),
};
