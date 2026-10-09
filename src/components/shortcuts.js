// Global keyboard shortcuts. Ignored while typing (input/textarea/select/
// contenteditable) and while a modal dialog is open.
//
//   Ctrl/⌘+K   command palette (works everywhere, also inside inputs)
//   ?          shortcut help
//   G then X   go to page (D N T C H K E S R)
//   N          quick-add menu
//   /          search (palette) — unless the page has its own search box
//   Esc        closes dialogs, menus and the phone drawer (handled where they live)
//
// Pages own their single keys (tasks: N Shift+N / J K X E Enter Space Esc ?;
// notes: N /; calendar: ← → T; time: Space F; expenses: /). A page handler on
// `document` that calls preventDefault wins — "?" on the tasks page opens the
// tasks help (keys + quick-add syntax) instead of this global dialog, which in
// turn lists the current page's keys (PAGE_KEYS).
// Page handlers sit on `document`; the plain-key handler here sits on
// `window` (bubble) and yields when a page already called preventDefault.
// Only the second key of a "G …" sequence is taken in the capture phase,
// so "G K" reaches KPI instead of the tasks list's K.
import { html, fragment } from '../utils/dom.js';
import { openModal } from './modal.js';
import { NAV } from './shell.js';
import { navigate, current } from '../core/router.js';
import { GO_KEYS, MOD, togglePalette, isPaletteOpen, openPalette } from './commandPalette.js';

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
    } else if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) {
      e.preventDefault();
      onQuickAdd();
    } else if (e.key === '/') {
      // Tasks / notes / expenses focus their own search first (preventDefault).
      e.preventDefault();
      openPalette();
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

// Single-key shortcuts each page implements (keep in sync with src/pages/*.js).
const PAGE_KEYS = {
  '/tasks': ['Trang Công việc', [
    [['N'], 'Thêm việc nhanh'], [['Shift', '+', 'N'], 'Thêm bằng biểu mẫu đầy đủ'], [['/'], 'Tìm trong danh sách'],
    [['J', '|', 'K'], 'Xuống / lên'], [['Enter'], 'Mở chi tiết'], [['Space'], 'Hoàn thành / mở lại'],
    [['E'], 'Sửa bằng biểu mẫu'], [['X'], 'Chọn / bỏ chọn'], [['Esc'], 'Bỏ chọn'], [['?'], 'Trợ giúp & cú pháp nhập nhanh'],
  ]],
  '/notes': ['Trang Ghi chú', [
    [['N'], 'Ghi chú mới'], [['/'], 'Tìm ghi chú'], [[MOD, '+', 'S'], 'Lưu ngay'], [[MOD, '+', '/'], 'Soạn thảo / xem trước'],
  ]],
  '/calendar': ['Trang Lịch', [[['←', '|', '→'], 'Kỳ trước / kỳ sau'], [['T'], 'Về hôm nay']]],
  '/time': ['Trang Thời gian', [[['Space'], 'Bắt đầu / tạm dừng / tiếp tục'], [['F'], 'Chế độ tập trung'], [['Esc'], 'Thoát chế độ tập trung']]],
  '/expenses': ['Trang Chi tiêu', [[['/'], 'Nhập nhanh khoản chi']]],
};

function pageSection() {
  const entry = PAGE_KEYS[current().path];
  if (!entry) return '';
  const [title, rows] = entry;
  return html`<h3 class="eyebrow">${title}</h3>
          <ul class="keys-list">${rows.map(([k, label]) => row(k, label))}</ul>`;
}

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
            ${row(['/'], 'Tìm kiếm')}
            ${row(['?'], 'Mở bảng phím tắt này')}
            ${row(['Esc'], 'Đóng hộp thoại / menu')}
          </ul>
          <h3 class="eyebrow">Trong bảng lệnh</h3>
          <ul class="keys-list">
            ${row(['↑', '|', '↓'], 'Chọn kết quả')}
            ${row(['↵'], 'Mở')}
          </ul>
          ${pageSection()}
        </section>
        <section>
          <h3 class="eyebrow">Đi tới</h3>
          <ul class="keys-list">${go}</ul>
        </section>
      </div>
      <p class="keys-note muted">Phím tắt tạm tắt khi bạn đang gõ trong ô nhập liệu.</p>`,
  });
}
