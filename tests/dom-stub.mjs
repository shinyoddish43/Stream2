// The browser globals the front-end modules read at import time. Imported
// first by the Node test suites so they can exercise real application code
// without a browser. Anything a test needs to observe gets a real
// implementation; everything else is a no-op.

const storage = new Map();

globalThis.window = globalThis.window || { STUDIO_BOOT: {} };
globalThis.localStorage = globalThis.localStorage || {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};
globalThis.document = globalThis.document || {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {} }),
  addEventListener: () => {},
};
globalThis.fetch = globalThis.fetch || (async () => { throw new Error('offline in tests'); });
