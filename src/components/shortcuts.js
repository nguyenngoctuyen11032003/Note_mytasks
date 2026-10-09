// Global keyboard shortcuts. Ignored while typing (input/textarea/select/
// contenteditable) and while a modal dialog is open.
//
//   Ctrl/⌘+K   command palette (works everywhere, also inside inputs)
//   ?          shortcut help
//   G then X   go to page (D N T C H K E S R)
//   N          quick-add menu
//
// Pages own their single keys (tasks: Space J K X E Enter /, and may own N).
// Page handlers sit on `document`; the plain-key handler here sits on
// `window` (bubble) and yields when a page already called preventDefault.
// Only the second key of a "G …" sequence is taken in the capture phase,
// so "G K" reaches KPI instead of the tasks list's K.
import { html, fragment } from '../utils/dom.js';
import { openModal } from './modal.js';
import { NAV } from './shell.js';
import { navigate } from '../core/router.js';
import { GO_KEYS, MOD, togglePalette, isPaletteOpen } from './commandPalette.js';

const SEQ_MS = 1200;

const isTyping = (t) =>
  t instanceof Element && (t.isContentEditable || Boolean(t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')));
const modalOpen = () => Boolean(document.querySelector('dialog[open]'));

let hintEl = null;
let hintTimer = null;
function showHint(on) {
  clearTimeout(hintTimer);
  if (!on) {
    hintEl?.classList.remove('is-on');
    return;
  }
  if (!hintEl) {
    hintEl = fragment(html`
      <div class="keyhint" aria-hidden="true">
        <kbd>G</kbd><span>đi tới</span>
        ${Object.entries(GO_KEYS).map(([k, p]) => html`<span class="keyhint__k"><kbd>${k.toUpperCase()}</kbd>${NAV.find((n) => n.path === p)?.label}</span>`)}
      </div>`);
    document.body.append(hintEl);
  }
  requestAnimationFrame(() => hintEl.classList.add('is-on'));
  hintTimer = setTimeout(() => showHint(false), SEQ_MS);
}

/**
 * @param {object} o
 * @param {() => boolean} o.enabled     true while the authenticated shell is mounted
 * @param {() => void}    o.onQuickAdd  open the quick-add menu
 * @returns {() => void}  dispose
 */
export function initShortcuts({ enabled, onQuickAdd }) {
  let pendingG = 0;

  const capture = (e) => {
    if (!enabled()) return;
    // Ctrl/⌘+K — palette, from anywhere (also inside text fields).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      if (modalOpen() && !isPaletteOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      togglePalette();
      return;
    }
    if (!pendingG) return;
    if (Date.now() - pendingG > SEQ_MS) { pendingG = 0; return; }
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    const path = !e.ctrlKey && !e.metaKey && !e.altKey ? GO_KEYS[e.key.toLowerCase()] : null;
    pendingG = 0;
    showHint(false);
    if (!path || isTyping(e.target) || modalOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    navigate(path);
  };

  const bubble = (e) => {
    if (!enabled() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (isTyping(e.target) || modalOpen()) return;
    if (e.key === '?') {
      e.preventDefault();
      openShortcutHelp();
    } else if (e.key === 'g' || e.key === 'G') {
      pendingG = Date.now();
      showHint(true);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      onQuickAdd();
    }
  };

  window.addEventListener('keydown', capture, true);
  window.addEventListener('keydown', bubble);
  return () => {
    window.removeEventListener('keydown', capture, true);
    window.removeEventListener('keydown', bubble);
  };
}

/* ------------------------------------------------------------------ */

const row = (keys, label) => html`<li><span class="keys">${keys.map((k, i) => {
  if (k === '+') return html`<span class="keys__sep">+</span>`;
  if (k === '|') return html`<span class="keys__sep">/</span>`;
  const then = i > 0 && !['+', '|'].includes(keys[i - 1]);
  return html`${then ? html`<span class="keys__then">rồi</span>` : ''}<kbd>${k}</kbd>`;
})}</span><span>${label}</span></li>`;

export function openShortcutHelp() {
  if (document.querySelector('.dialog--keys')) return;
  const go = Object.entries(GO_KEYS).map(([k, p]) => row(['G', k.toUpperCase()], NAV.find((n) => n.path === p)?.label || p));
  openModal({
    eyebrow: 'Bàn phím',
    title: 'Phím tắt',
    size: 'keys',
    onSubmit: null,
    body: html`
      <div class="keys-grid">
        <section>
          <h3 class="eyebrow">Chung</h3>
          <ul class="keys-list">
            ${row([MOD, '+', 'K'], 'Bảng lệnh & tìm kiếm')}
            ${row(['N'], 'Tạo mới…')}
            ${row(['?'], 'Mở bảng phím tắt này')}
            ${row(['Esc'], 'Đóng hộp thoại / menu')}
          </ul>
          <h3 class="eyebrow">Trong bảng lệnh</h3>
          <ul class="keys-list">
            ${row(['↑', '|', '↓'], 'Chọn kết quả')}
            ${row(['↵'], 'Mở')}
          </ul>
          <h3 class="eyebrow">Trang Công việc</h3>
          <ul class="keys-list">
            ${row(['J', '|', 'K'], 'Xuống / lên')}
            ${row(['/'], 'Tìm trong danh sách')}
          </ul>
        </section>
        <section>
          <h3 class="eyebrow">Đi tới</h3>
          <ul class="keys-list">${go}</ul>
        </section>
      </div>
      <p class="keys-note muted">Phím tắt tạm tắt khi bạn đang gõ trong ô nhập liệu.</p>`,
  });
}
