// Authenticated application frame: sidebar navigation (collapsible to an
// icon rail on desktop, a drawer on tablet/phone), topbar, content sheet and
// — under 768px — a bottom tab bar with a centre quick-add button.
import { html, mount, on } from '../utils/dom.js';
import { icon } from './icons.js';
import * as store from '../core/store.js';
import { navigate } from '../core/router.js';
import { initials, clock, day } from '../utils/format.js';
import { today } from '../utils/date.js';
import { onTick, onPomodoro, pomodoro, formatCountdown, sessionSeconds, pausedSession } from './timer.js';
import { popMenu } from './ui.js';
import { applyTheme, currentThemePref, onThemeChange } from './theme.js';

export const NAV = [
  { group: 'Làm việc' },
  { path: '/dashboard', num: '01', label: 'Tổng quan', icon: 'dashboard' },
  { path: '/notes', num: '02', label: 'Ghi chú', icon: 'note' },
  { path: '/tasks', num: '03', label: 'Công việc', icon: 'tasks' },
  { path: '/calendar', num: '04', label: 'Lịch', icon: 'calendar' },
  { path: '/time', num: '05', label: 'Thời gian', icon: 'clock' },
  { path: '/kpi', num: '06', label: 'Mục tiêu KPI', icon: 'target' },
  { group: 'Tài chính' },
  { path: '/expenses', num: '07', label: 'Chi tiêu', icon: 'wallet' },
  { path: '/shopping', num: '08', label: 'Mua sắm', icon: 'cart' },
  { group: 'Tổng hợp' },
  { path: '/reports', num: '09', label: 'Báo cáo', icon: 'chart' },
  { path: '/settings', num: '10', label: 'Cài đặt', icon: 'settings' },
];

/** Bottom tab bar (phones): two tabs · quick-add · one tab + "Thêm" (symmetric 2 + FAB + 2).
 *  Chi tiêu & the rest stay one tap away via the FAB menu and the "Thêm" drawer. */
const TABS_LEFT = [
  { path: '/dashboard', label: 'Tổng quan', icon: 'dashboard' },
  { path: '/tasks', label: 'Việc', icon: 'tasks' }, // short: 'Công việc' collides at 360px
];
const TABS_RIGHT = [
  { path: '/notes', label: 'Ghi chú', icon: 'note' },
];

const RAIL_KEY = 'nm.sidebar';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

let root = null;
let unsubs = [];

export function isMounted() {
  return Boolean(root && document.body.contains(root));
}

export function mountShell(app, { onSignOut, onQuickAdd, onSearch }) {
  unmountShell();
  const tab = (t) => html`<a class="tabbar__tab" href="#${t.path}" data-path="${t.path}">${icon(t.icon)}<span>${t.label}</span></a>`;
  mount(app, html`
    <div class="shell">
      <a class="skip-link" href="#/" data-act="skip">Bỏ qua, tới nội dung chính</a>
      <aside class="sidebar" id="sidebar" aria-label="Điều hướng chính">
        <div class="sidebar__top">
          <a class="brand" href="#/dashboard" aria-label="Note_mytasks — Tổng quan">
            <span class="brand__mark" aria-hidden="true">N</span>
            <span class="brand__text"><span class="brand__name">Note<em>_</em>mytasks</span><span class="brand__sub">Sổ tay cá nhân</span></span>
          </a>
          <button class="icon-btn sidebar__close" type="button" data-act="close-nav" aria-label="Đóng menu">${icon('x')}</button>
        </div>
        <nav class="nav" aria-label="Các trang">
          ${NAV.map((n) => n.group
            ? html`<div class="nav__group"><span>${n.group}</span></div>`
            : html`<a class="nav__item" href="#${n.path}" data-path="${n.path}" data-tip="${n.label}">${icon(n.icon)}<span class="nav__label">${n.label}</span><span data-badge="${n.path}"></span></a>`)}
        </nav>
        <div class="sidebar__foot">
          <a class="usercard" href="#/settings" data-usercard></a>
          <button class="rail-toggle" type="button" data-act="rail" aria-pressed="false">
            ${icon('chevronLeft')}<span class="rail-toggle__label">Thu gọn</span>
          </button>
        </div>
      </aside>
      <div class="scrim" data-act="close-nav" aria-hidden="true"></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn topbar__menu" type="button" data-act="open-nav" aria-label="Mở menu" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
          <div class="topbar__crumb">
            <span class="topbar__sect" data-sect></span>
            <span class="topbar__title" data-title></span>
            <span class="topbar__date">${day(today(), 'long')}</span>
          </div>
          <div class="topbar__spacer"></div>
          <div class="topbar__actions">
            <button class="topbar__search" type="button" data-act="search" aria-label="Tìm kiếm và lệnh (${isMac ? '⌘' : 'Ctrl'}+K)" aria-haspopup="dialog">
              ${icon('search')}<span class="topbar__search-text">Tìm hoặc chạy lệnh…</span><span class="topbar__search-kbd"><kbd>${isMac ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd></span>
            </button>
            <span data-timer></span>
            <button class="icon-btn" type="button" data-act="theme" aria-label="Đổi giao diện sáng/tối" aria-haspopup="menu">${icon('sun')}</button>
            <button class="btn btn--primary btn--sm topbar__add" type="button" data-act="quick-add" aria-haspopup="menu">${icon('plus')}<span>Tạo mới</span></button>
          </div>
        </header>
        <main class="content" id="content" tabindex="-1"></main>
      </div>
      <nav class="tabbar" aria-label="Điều hướng nhanh">
        <div class="tabbar__side">${TABS_LEFT.map(tab)}</div>
        <button class="tabbar__fab" type="button" data-act="quick-add" aria-haspopup="menu" aria-label="Tạo mới">${icon('plus')}</button>
        <div class="tabbar__side">
          ${TABS_RIGHT.map(tab)}
          <button class="tabbar__tab" type="button" data-act="open-nav" aria-controls="sidebar" aria-expanded="false">${icon('menu')}<span>Thêm</span></button>
        </div>
      </nav>
    </div>`);
  root = app.firstElementChild;
  document.body.classList.add('has-shell');

  renderUser();
  renderThemeIcon();
  renderTimer();
  syncRail();

  unsubs.push(store.subscribe((_, patch) => {
    if ('profile' in patch || 'user' in patch) renderUser();
    if ('runningEntry' in patch) renderTimer();
  }));
  unsubs.push(onTick(updateTimerText));
  // Pomodoro breaks tick through onPomodoro (no running entry → onTick is silent).
  let lastPhase = null;
  unsubs.push(onPomodoro((pm) => {
    const phase = pm.enabled ? pm.phase : 'idle';
    if (phase !== lastPhase) { lastPhase = phase; renderTimer(); }
    else if (phase === 'break') updateTimerText();
  }));
  unsubs.push(onThemeChange(renderThemeIcon));
  unsubs.push(on(root, 'click', '[data-act]', (e, el) => {
    const act = el.dataset.act;
    if (act === 'skip') { e.preventDefault(); focusContent(); }
    if (act === 'open-nav') setNav(true, el);
    if (act === 'close-nav') setNav(false);
    if (act === 'theme') cycleTheme(el);
    if (act === 'quick-add') onQuickAdd(el);
    if (act === 'search') onSearch?.();
    if (act === 'rail') toggleRail();
    if (act === 'signout') onSignOut();
  }));
  unsubs.push(on(root, 'click', '.nav__item, .usercard, .brand', () => { if (root.classList.contains('nav-open')) setNav(false, null, false); }));

  const onKey = (e) => {
    if (e.key === 'Escape' && root?.classList.contains('nav-open')) setNav(false);
  };
  document.addEventListener('keydown', onKey);
  unsubs.push(() => document.removeEventListener('keydown', onKey));

  // Phones: tuck the tab bar away while reading downwards, bring it back on
  // any upward scroll or near the end of the page.
  let lastY = window.scrollY;
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!root) return;
      const y = Math.max(0, window.scrollY);
      const dy = y - lastY;
      const nearEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 24;
      if (Math.abs(dy) < 6 && !nearEnd) return;
      root.classList.toggle('tabbar-hidden', dy > 0 && y > 80 && !nearEnd);
      lastY = y;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  unsubs.push(() => window.removeEventListener('scroll', onScroll));
  // Keep the bar visible while the keyboard user tabs into it.
  unsubs.push(on(root, 'focusin', '.tabbar', () => root.classList.remove('tabbar-hidden')));

  // Leaving the drawer layout (rotate / resize) must not leave it stuck open.
  const mq = window.matchMedia('(min-width: 961px)');
  const onMq = () => { if (mq.matches && root?.classList.contains('nav-open')) setNav(false, null, false); };
  mq.addEventListener?.('change', onMq);
  unsubs.push(() => mq.removeEventListener?.('change', onMq));

  return root.querySelector('#content');
}

export function unmountShell() {
  unsubs.forEach((u) => u());
  unsubs = [];
  root = null;
  document.body.classList.remove('has-shell');
}

export function setActive(path) {
  if (!root) return;
  const item = NAV.find((n) => n.path === path);
  root.querySelectorAll('.nav__item, .tabbar__tab[data-path]').forEach((a) => {
    if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const inTabs = [...TABS_LEFT, ...TABS_RIGHT].some((t) => t.path === path);
  root.querySelector('.tabbar [data-act="open-nav"]')?.classList.toggle('is-current', !inTabs);
  root.querySelector('[data-sect]').textContent = '';
  root.querySelector('[data-title]').textContent = item?.label || '';
  root.classList.remove('tabbar-hidden');
  document.title = item ? `${item.label} · Note_mytasks` : 'Note_mytasks';
}

export function setBadge(path, value) {
  const el = root?.querySelector(`[data-badge="${path}"]`);
  if (!el) return;
  el.className = value ? 'nav__badge' : '';
  el.textContent = value ? String(value) : '';
}

/** Move focus to the page heading (or the content sheet) for screen readers. */
export function focusContent() {
  const content = root?.querySelector('#content');
  if (!content) return;
  const h1 = content.querySelector('h1');
  const target = h1 || content;
  if (h1 && !h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

function setNav(open, opener = null, restoreFocus = true) {
  if (!root) return;
  root.classList.toggle('nav-open', open);
  root.querySelectorAll('[data-act="open-nav"]').forEach((b) => b.setAttribute('aria-expanded', String(open)));
  const sidebar = root.querySelector('.sidebar');
  if (open) {
    sidebar._opener = opener;
    // The rest of the page is inert while the drawer is open.
    root.querySelector('.main').inert = true;
    root.querySelector('.tabbar').inert = true;
    (sidebar.querySelector('.nav__item[aria-current]') || sidebar.querySelector('.nav__item'))?.focus({ preventScroll: true });
  } else {
    root.querySelector('.main').inert = false;
    root.querySelector('.tabbar').inert = false;
    if (restoreFocus) sidebar._opener?.focus?.({ preventScroll: true });
    sidebar._opener = null;
  }
}

/* ---------- Desktop icon rail ---------- */
function isRail() {
  return document.documentElement.dataset.sidebar === 'rail';
}
function syncRail() {
  const btn = root?.querySelector('[data-act="rail"]');
  if (!btn) return;
  const on = isRail();
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên');
  btn.title = on ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên';
  btn.querySelector('.rail-toggle__label').textContent = on ? 'Mở rộng' : 'Thu gọn';
  // Labels are visually hidden in the rail: native tooltips name the icons.
  root.querySelectorAll('.nav__item, .usercard').forEach((a) => {
    if (on && a.dataset.tip) a.title = a.dataset.tip;
    else a.removeAttribute('title');
  });
}
function toggleRail() {
  const on = !isRail();
  if (on) document.documentElement.dataset.sidebar = 'rail';
  else delete document.documentElement.dataset.sidebar;
  try { on ? localStorage.setItem(RAIL_KEY, 'rail') : localStorage.removeItem(RAIL_KEY); } catch {}
  syncRail();
  // Charts size to their container — let them reflow after the transition.
  setTimeout(() => window.dispatchEvent(new Event('resize')), 280);
}

function renderUser() {
  if (!root) return;
  const name = store.displayName();
  const email = store.get().user?.email || '';
  const card = root.querySelector('[data-usercard]');
  card.dataset.tip = name;
  if (isRail()) card.title = name;
  mount(card, html`
    <span class="avatar">${initials(name)}</span>
    <span class="usercard__text truncate"><span class="usercard__name truncate" style="display:block">${name}</span><span class="usercard__mail truncate" style="display:block">${email}</span></span>
    ${icon('settings', 'faint usercard__gear')}`);
}

function renderThemeIcon() {
  const btn = root?.querySelector('[data-act="theme"]');
  if (!btn) return;
  const pref = currentThemePref();
  const label = pref === 'dark' ? 'Tối' : pref === 'light' ? 'Sáng' : 'Theo hệ thống';
  btn.innerHTML = String(icon(pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'monitor'));
  btn.title = `Giao diện: ${label}`;
  btn.setAttribute('aria-label', `Giao diện: ${label}. Đổi giao diện`);
}

function cycleTheme(anchor) {
  popMenu(anchor, [
    { label: 'Sáng', icon: 'sun', onClick: () => applyTheme('light', { persist: true }) },
    { label: 'Tối', icon: 'moon', onClick: () => applyTheme('dark', { persist: true }) },
    { label: 'Theo hệ thống', icon: 'monitor', onClick: () => applyTheme('system', { persist: true }) },
  ]);
}

/** Pomodoro break in progress (no running entry) → the chip shows "Nghỉ" + countdown. */
function breakState() {
  if (store.get().runningEntry) return null;
  const pm = pomodoro();
  return pm.enabled && pm.phase === 'break' ? pm : null;
}

function renderTimer() {
  const slot = root?.querySelector('[data-timer]');
  if (!slot) return;
  const run = store.get().runningEntry;
  const brk = breakState();
  const paused = !run && pausedSession();
  if (!run && !paused && !brk) { slot.innerHTML = ''; return; }
  const title = paused?.title || 'Phiên tính giờ';
  const label = run ? run.task?.title || run.description || 'Không gắn công việc'
    : brk ? `Nghỉ ${brk.breakKind === 'long' ? 'dài' : 'ngắn'}${paused ? ` · ${title}` : ''}`
      : `Tạm dừng · ${title}`;
  const state = run ? 'Đang tính giờ' : brk ? 'Đang nghỉ' : 'Đã tạm dừng';
  const time = brk ? formatCountdown(brk.remaining) : clock(sessionSeconds());
  mount(slot, html`
    <a class="timer-chip ${brk ? 'is-break' : paused ? 'is-paused' : ''}" href="#/time" title="${label}" aria-label="${state}: ${label}">
      <span class="timer-chip__pulse"></span>
      <span class="timer-chip__time" data-timer-text>${time}</span>
      <span class="timer-chip__task truncate">${label}</span>
    </a>`);
}

function updateTimerText() {
  if (!root) return;
  const el = root.querySelector('[data-timer-text]');
  const brk = breakState();
  if (el && store.get().runningEntry) el.textContent = clock(sessionSeconds());
  else if (el && brk && root.querySelector('.timer-chip.is-break')) el.textContent = formatCountdown(brk.remaining);
  else renderTimer();
}

export { navigate };
