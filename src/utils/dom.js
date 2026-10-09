// Tiny safe-HTML templating. Every interpolated value is escaped unless it is
// itself the result of html`` / raw(). Arrays are joined.

class SafeHTML {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
export const raw = (s) => new SafeHTML(String(s ?? ''));

/**
 * URL that is safe to put in href/src: http(s), mailto, tel, or a relative /
 * hash / query URL. Anything with another scheme (javascript:, data:, vbscript:,
 * file:, …) becomes `fallback`. Control characters and whitespace that browsers
 * strip before parsing the scheme ("java\tscript:") are taken into account.
 */
export function safeUrl(u, fallback = '#') {
  const s = String(u ?? '').trim();
  if (!s) return fallback;
  // eslint-disable-next-line no-control-regex
  const probe = s.replace(/[\u0000- \u007f-\u009f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!scheme) return s; // relative: '#/tasks', '/x', '?q=1', 'page.html'
  return /^(https?|mailto|tel)$/i.test(scheme[1]) ? s : fallback;
}

// Attribute whose value is a URL: interpolations there go through safeUrl().
const URL_ATTR = /\s(?:href|src|action|formaction|xlink:href|poster|cite|background)\s*=\s*["']$/i;

function render(v) {
  if (v == null || v === false || v === true) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (v instanceof SafeHTML) return v.s;
  return esc(v);
}

export function html(strings, ...values) {
  let out = '';
  strings.forEach((str, i) => {
    out += str;
    if (i >= values.length) return;
    const v = values[i];
    // Inside an attribute value (aria-pressed="${bool}") booleans print as text;
    // in content position they render nothing (so `${cond && html`…`}` works).
    if (typeof v === 'boolean' && str.endsWith('="')) out += String(v);
    // href="${x}" / src="${x}": a full URL is interpolated → block script schemes.
    else if (v != null && !(v instanceof SafeHTML) && !Array.isArray(v) && URL_ATTR.test(str)) out += esc(safeUrl(v));
    else out += render(v);
  });
  return new SafeHTML(out);
}

export function mount(el, tpl) {
  el.innerHTML = String(tpl);
  return el;
}

export function fragment(tpl) {
  const t = document.createElement('template');
  t.innerHTML = String(tpl).trim();
  return t.content.firstElementChild;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated event: on(root, 'click', '[data-act]', (e, el) => …) */
export function on(root, type, selector, handler, opts) {
  const fn = (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  };
  root.addEventListener(type, fn, opts);
  return () => root.removeEventListener(type, fn, opts);
}

/** Read a <form> into a plain object. Checkboxes → boolean, multiple names → array. */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue; }
    out[el.name] = typeof el.value === 'string' ? el.value.trim() : el.value;
  }
  return out;
}

export function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle('is-loading', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/** Show/clear field errors. errors = { fieldName: 'message' } */
export function showErrors(form, errors = {}) {
  for (const f of form.querySelectorAll('.field')) {
    f.classList.remove('has-error');
    const ctl = f.querySelector('[name]');
    ctl?.removeAttribute('aria-invalid');
  }
  let first = null;
  for (const [name, msg] of Object.entries(errors)) {
    const ctl = form.querySelector(`[name="${name}"]`);
    const field = ctl?.closest('.field');
    if (!field) continue;
    field.classList.add('has-error');
    ctl.setAttribute('aria-invalid', 'true');
    const box = field.querySelector('.field__error');
    if (box) box.textContent = msg;
    first ??= ctl;
  }
  first?.focus();
  return !first;
}
