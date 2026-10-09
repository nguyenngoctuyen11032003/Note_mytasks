// Small presentational helpers shared by several pages.
import { html, raw } from '../utils/dom.js';
import { icon } from './icons.js';
import { categoryById, categoriesOf } from '../core/store.js';
import { today, diffDays } from '../utils/date.js';
import { relDay } from '../utils/format.js';

export const TASK_STATUS = {
  todo: { label: 'Cần làm', badge: 'muted' },
  in_progress: { label: 'Đang làm', badge: 'info' },
  completed: { label: 'Hoàn thành', badge: 'success' },
  cancelled: { label: 'Đã hủy', badge: 'plain' },
};
export const TASK_PRIORITY = {
  low: 'Thấp',
  medium: 'Trung bình',
  high: 'Cao',
  urgent: 'Khẩn cấp',
};
export const PRIORITY_RANK = { urgent: 0, must_buy: 0, high: 1, medium: 2, low: 3 };

export const statusBadge = (s) => html`<span class="badge badge--${TASK_STATUS[s]?.badge || 'muted'}">${TASK_STATUS[s]?.label || s}</span>`;

export function prio(p, labels = TASK_PRIORITY) {
  return html`<span class="prio" data-p="${p}" title="Ưu tiên: ${labels[p] || p}"><span class="prio__bars"><i></i><i></i><i></i></span>${labels[p] || p}</span>`;
}

export function catLabel(categoryId, fallback = 'Chưa phân loại') {
  const c = categoryId ? categoryById(categoryId) : null;
  return html`<span class="cat" style="--c:${c?.color || 'var(--ink-4)'}"><span class="cat__dot"></span><span class="truncate">${c?.name || fallback}</span></span>`;
}

export function dueLabel(due, status) {
  if (!due) return '';
  const done = status === 'completed' || status === 'cancelled';
  const d = diffDays(due, today());
  const cls = done ? '' : d < 0 ? 'due--overdue' : d === 0 ? 'due--today' : '';
  const text = !done && d < 0 ? `Quá hạn · ${relDay(due)}` : relDay(due);
  return html`<span class="due ${cls}">${icon('calendar')}${text}</span>`;
}

export function categoryOptions(kind, { all, none } = {}) {
  const opts = [];
  if (all) opts.push({ value: '', label: all });
  if (none) opts.push({ value: 'none', label: none });
  for (const c of categoriesOf(kind)) opts.push({ value: c.id, label: c.name });
  return opts;
}

/** Circular progress ring. p = 0..100+ */
export function ring(p, { size = 72, color, label } = {}) {
  const r = 30, c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, p));
  return html`
    <div class="ring" style="--size:${size}px;${color ? `--c:${color}` : ''}" role="img" aria-label="Tiến độ ${Math.round(p)}%">
      <svg viewBox="0 0 72 72"><circle class="ring__track" cx="36" cy="36" r="${r}"/><circle class="ring__val" cx="36" cy="36" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - clamped / 100)).toFixed(2)}"/></svg>
      <span class="ring__label">${label ?? Math.round(p) + '%'}</span>
    </div>`;
}

export function bar(p, { color, thin, over } = {}) {
  const w = Math.max(0, Math.min(100, p));
  return html`<div class="bar ${thin ? 'bar--thin' : ''} ${over ? 'bar--over' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"><span style="width:${w}%;${color ? `--c:${color}` : ''}"></span></div>`;
}

export function pageHead({ num, kicker, title, lede, actions = '' }) {
  return html`
    <header class="page-head">
      <div>
        ${kicker ? html`<div class="page-head__eyebrow"><span class="eyebrow">${kicker}</span></div>` : ''}
        <h1>${raw(title)}</h1>
        ${lede ? html`<p class="page-head__lede">${lede}</p>` : ''}
      </div>
      <div class="page-head__actions">${actions}</div>
    </header>`;
}

// `num` is accepted for compatibility but no longer rendered (no section numbering in the UI).
export function sheetHead(num, title, right = '') {
  return html`<div class="sheet__head"><div class="sheet__title"><h2>${title}</h2></div>${right}</div>`;
}

/* ---------- Popover menu ---------- */
let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
/** items: [{ label, icon, onClick, danger }] or 'sep' */
export function popMenu(anchor, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = String(html`${items.map((it, i) => (it === 'sep' ? html`<hr />` : html`<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'is-danger' : ''}">${it.icon ? icon(it.icon) : ''}${it.label}</button>`))}`);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(r.right - w, window.innerWidth - w - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  Object.assign(el.style, { left: left + 'px', top: top + 'px' });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it.onClick?.();
  });
  el.addEventListener('keydown', (e) => {
    const btns = [...el.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    if (e.key === 'Escape') { closeMenu(); anchor.focus(); }
  });
  openMenuEl = el;
  el.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('pointerdown', outside, { once: true }), 0);
  function outside(e) {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
    else if (openMenuEl) document.addEventListener('pointerdown', outside, { once: true });
  }
}
window.addEventListener('hashchange', closeMenu);
window.addEventListener('resize', closeMenu);

/* ---------- Tag input ---------- */
export function tagInput(name, tags = []) {
  return html`
    <div class="tag-input" data-tag-input="${name}">
      ${tags.map((t) => html`<span class="tag" data-tag="${t}">${t}<button type="button" aria-label="Bỏ thẻ ${t}">${icon('x')}</button></span>`)}
      <input id="__ID__" type="text" placeholder="${tags.length ? '' : 'Gõ thẻ rồi nhấn Enter'}" autocomplete="off" maxlength="40" />
      <input type="hidden" name="${name}" value="${JSON.stringify(tags)}" />
    </div>`;
}

export function bindTagInput(root) {
  root.querySelectorAll('[data-tag-input]').forEach((box) => {
    const text = box.querySelector('input[type=text]');
    const hidden = box.querySelector('input[type=hidden]');
    const read = () => JSON.parse(hidden.value || '[]');
    const write = (tags) => {
      hidden.value = JSON.stringify(tags);
      box.querySelectorAll('.tag').forEach((t) => t.remove());
      tags.forEach((t) => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.dataset.tag = t;
        span.innerHTML = `${escapeText(t)}<button type="button" aria-label="Bỏ thẻ">${icon('x')}</button>`;
        box.insertBefore(span, text);
      });
      text.placeholder = tags.length ? '' : 'Gõ thẻ rồi nhấn Enter';
    };
    const add = () => {
      const v = text.value.trim().replace(/^#/, '').replace(/,$/, '').toLowerCase();
      if (!v) return;
      const tags = read();
      if (!tags.includes(v) && tags.length < 20) write([...tags, v]);
      text.value = '';
    };
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      if (e.key === 'Backspace' && !text.value) { const t = read(); t.pop(); write(t); }
    });
    text.addEventListener('blur', add);
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.tag button');
      if (b) { const tag = b.parentElement.dataset.tag; write(read().filter((t) => t !== tag)); }
      else text.focus();
    });
  });
}
const escapeText = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const SWATCHES = ['#B4532A', '#C45B8E', '#7C6BC4', '#3B82C4', '#2FA4A9', '#4F9D5D', '#D4A72C', '#E5793B', '#D9534F', '#8A8F98'];
export function swatchPicker(name, selected) {
  const sel = (selected || SWATCHES[0]).toUpperCase();
  return html`<div class="swatches" role="radiogroup">
    ${SWATCHES.map((c) => html`<label class="swatch" style="background:${c}" title="${c}"><input type="radio" name="${name}" value="${c}" ${c === sel ? raw('checked') : ''} aria-label="Màu ${c}" /></label>`)}
  </div>`;
}
