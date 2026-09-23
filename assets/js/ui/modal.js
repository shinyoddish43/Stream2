// One modal host reused by every dialog. Focus trapping, Escape to close,
// and a tiny form builder so the dialogs stay declarative.

import { $, el } from '../core/util.js';

let current = null;

export function openModal({ title, body, footer = [], wide = false, onClose }) {
  // Replacing an open dialog still closes it, so its cleanup has to run.
  if (current && current.onClose) {
    const previous = current.onClose;
    current = null;
    try { previous(); } catch (e) { console.error('[modal] close handler', e); }
  }
  const root = $('#modalRoot');
  const bodyHost = $('#modalBody');
  const footHost = $('#modalFoot');
  $('#modalTitle').textContent = title;
  bodyHost.innerHTML = '';
  footHost.innerHTML = '';
  bodyHost.appendChild(body instanceof Node ? body : el('div', { html: String(body) }));
  for (const item of footer) footHost.appendChild(item);
  root.querySelector('.modal').classList.toggle('wide', !!wide);
  root.hidden = false;
  current = { onClose };
  const focusable = bodyHost.querySelector('input,select,textarea,button');
  if (focusable) setTimeout(() => focusable.focus(), 20);
  return { close: closeModal, body: bodyHost, footer: footHost };
}

export function closeModal() {
  const root = $('#modalRoot');
  if (!root || root.hidden) return;
  root.hidden = true;
  if (current && current.onClose) current.onClose();
  current = null;
}

export const isModalOpen = () => !$('#modalRoot').hidden;

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isModalOpen()) { event.preventDefault(); closeModal(); }
});

// ---------------------------------------------------------- form building

export function field(label, control, hint) {
  return el('label', { class: 'field' }, [
    el('span', { text: label }),
    control,
    hint ? el('output', { text: hint }) : el('span', {}),
  ]);
}

export function input(attrs = {}) { return el('input', Object.assign({ type: 'text' }, attrs)); }

export function select(options, value, attrs = {}) {
  const node = el('select', attrs);
  for (const option of options) {
    const [val, label] = Array.isArray(option) ? option : [option, option];
    const opt = el('option', { value: val, text: label });
    if (String(val) === String(value)) opt.selected = true;
    node.appendChild(opt);
  }
  return node;
}

export function checkbox(label, checked, onChange) {
  const box = el('input', { type: 'checkbox' });
  box.checked = !!checked;
  box.addEventListener('change', () => onChange(box.checked));
  return el('label', { class: 'check' }, [box, label]);
}

export function slider({ min = 0, max = 100, step = 1, value = 0, format = (v) => v, onInput }) {
  const out = el('output', { text: format(value) });
  const range = el('input', { type: 'range', min, max, step, value });
  range.addEventListener('input', () => {
    out.textContent = format(Number(range.value));
    onInput(Number(range.value));
  });
  return { range, out };
}

export function button(label, attrs = {}) {
  return el('button', Object.assign({ class: 'btn', text: label, type: 'button' }, attrs));
}

export function tabs(names, onSelect) {
  const host = el('div', { class: 'tabs' });
  const buttons = names.map((name, i) =>
    el('button', {
      text: name,
      class: i === 0 ? 'active' : '',
      onclick: () => {
        buttons.forEach((b) => b.classList.remove('active'));
        buttons[i].classList.add('active');
        onSelect(name, i);
      },
    }));
  buttons.forEach((b) => host.appendChild(b));
  return host;
}
