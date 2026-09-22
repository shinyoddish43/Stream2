// Keyboard hotkeys for the timer and the studio.
//
// Browsers cannot grab keys while the tab is in the background; that is a
// platform limit, not an oversight. For a runner playing full-screen games we
// document two escapes: the pop-out timer window, and the LiveSplit bridge
// (LiveSplit itself keeps global hotkeys and the studio follows along).

import { bus } from '../core/util.js';

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export class Hotkeys {
  constructor() {
    this.bindings = new Map();     // code -> action name
    this.capturing = null;
    this.enabled = true;
    this.onKey = this.onKey.bind(this);
    window.addEventListener('keydown', this.onKey, true);
  }

  setBindings(map) {
    this.bindings.clear();
    for (const [action, code] of Object.entries(map || {})) {
      if (code) this.bindings.set(normalize(code), action);
    }
  }

  /** Grab the next keypress and hand it back — used by the hotkey editor. */
  capture() {
    return new Promise((resolve) => { this.capturing = resolve; });
  }

  onKey(event) {
    if (this.capturing) {
      event.preventDefault();
      event.stopPropagation();
      const resolve = this.capturing;
      this.capturing = null;
      resolve(event.code === 'Escape' ? '' : describe(event));
      return;
    }
    if (!this.enabled) return;
    const target = event.target;
    if (target && (TYPING.has(target.tagName) || target.isContentEditable)) return;
    const action = this.bindings.get(describe(event));
    if (!action) return;
    event.preventDefault();
    bus.emit('hotkey', action);
  }

  destroy() { window.removeEventListener('keydown', this.onKey, true); }
}

function describe(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  parts.push(event.code);
  return parts.join('+');
}

const normalize = (code) => String(code).trim();

export const hotkeys = new Hotkeys();
