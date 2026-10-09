// Authenticated application frame: sidebar navigation, topbar, content sheet.
import { html, mount, on } from '../utils/dom.js';
import { icon } from './icons.js';
import * as store from '../core/store.js';
import { navigate } from '../core/router.js';
import { initials, clock, day } from '../utils/format.js';
import { today } from '../utils/date.js';
import { onTick, sessionSeconds, pausedSession } from './timer.js';
import { popMenu } from './ui.js';
import { applyTheme, currentThemePref } from './theme.js';

export const NAV = [
  { group: 'Làm việc' },
  { path: '/dashboard', num: '01', label: 'Tổng quan', icon: 'dashboard' },
  { path: '/tasks', num: '02', label: 'Công việc', icon: 'tasks' },
  { path: '/calendar', num: '03', label: 'Lịch', icon: 'calendar' },
  { path: '/time', num: '04', label: 'Thời gian', icon: 'clock' },
  { path: '/kpi', num: '05', label: 'Mục tiêu KPI', icon: 'target' },
  { group: 'Tài chính' },
  { path: '/expenses', num: '06', label: 'Chi tiêu', icon: 'wallet' },
  { path: '/shopping', num: '07', label: 'Mua sắm', icon: 'cart' },
  { group: 'Tổng hợp' },
  { path: '/reports', num: '08', label: 'Báo cáo', icon: 'chart' },
  { path: '/settings', num: '09', label: 'Cài đặt', icon: 'settings' },
];

let root = null;
let unsubs = [];

export function isMounted() {
  return Boolean(root && document.body.contains(root));
}

export function mountShell(app, { onSignOut, onQuickAdd }) {
  unmountShell();
  const s = store.get();
  mount(app, html`
    <div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="Điều hướng chính">
        <a class="brand" href="#/dashboard">
          <span class="brand__mark">N</span>
          <span><span class="brand__name">Note<em>_</em>mytasks</span><span class="brand__sub">Sổ tay cá nhân</span></span>
        </a>
        <nav class="nav">
          ${NAV.map((n) => n.group
            ? html`<div class="nav__group">${n.group}</div>`
            : html`<a class="nav__item" href="#${n.path}" data-path="${n.path}"><span class="nav__num">${n.num}</span>${icon(n.icon)}<span>${n.label}</span><span data-badge="${n.path}"></span></a>`)}
        </nav>
        <div class="sidebar__foot">
          <a class="usercard" href="#/settings" data-usercard></a>
        </div>
      </aside>
      <div class="scrim" data-act="close-nav"></div>
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
            <span data-timer></span>
            <button class="icon-btn" type="button" data-act="theme" aria-label="Đổi giao diện sáng/tối" title="Giao diện">${icon('sun')}</button>
            <button class="btn btn--primary btn--sm" type="button" data-act="quick-add" aria-haspopup="menu">${icon('plus')}<span>Tạo mới</span></button>
          </div>
        </header>
        <main class="content" id="content" tabindex="-1"></main>
      </div>
    </div>`);
  root = app.firstElementChild;

  renderUser();
  renderThemeIcon();
  renderTimer();

  unsubs.push(store.subscribe((_, patch) => {
    if ('profile' in patch || 'user' in patch) renderUser();
    if ('runningEntry' in patch) renderTimer();
  }));
  unsubs.push(onTick(updateTimerText));
  unsubs.push(on(root, 'click', '[data-act]', (e, el) => {
    const act = el.dataset.act;
    if (act === 'open-nav') setNav(true);
    if (act === 'close-nav') setNav(false);
    if (act === 'theme') cycleTheme(el);
    if (act === 'quick-add') onQuickAdd(el);
    if (act === 'signout') onSignOut();
  }));
  unsubs.push(on(root, 'click', '.nav__item, .usercard, .brand', () => setNav(false)));

  const onKey = (e) => {
    if (e.key === 'Escape' && root.classList.contains('nav-open')) setNav(false);
  };
  document.addEventListener('keydown', onKey);
  unsubs.push(() => document.removeEventListener('keydown', onKey));

  return root.querySelector('#content');
}

export function unmountShell() {
  unsubs.forEach((u) => u());
  unsubs = [];
  root = null;
}

export function setActive(path) {
  if (!root) return;
  const item = NAV.find((n) => n.path === path);
  root.querySelectorAll('.nav__item').forEach((a) => {
    if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  root.querySelector('[data-sect]').textContent = item ? `§ ${item.num}` : '';
  root.querySelector('[data-title]').textContent = item?.label || '';
  document.title = item ? `${item.label} · Note_mytasks` : 'Note_mytasks';
}

export function setBadge(path, value) {
  const el = root?.querySelector(`[data-badge="${path}"]`);
  if (!el) return;
  el.className = value ? 'nav__badge' : '';
  el.textContent = value ? String(value) : '';
}

function setNav(open) {
  root.classList.toggle('nav-open', open);
  root.querySelector('[data-act="open-nav"]').setAttribute('aria-expanded', String(open));
}

function renderUser() {
  if (!root) return;
  const name = store.displayName();
  const email = store.get().user?.email || '';
  mount(root.querySelector('[data-usercard]'), html`
    <span class="avatar">${initials(name)}</span>
    <span class="truncate"><span class="usercard__name truncate" style="display:block">${name}</span><span class="usercard__mail truncate" style="display:block">${email}</span></span>
    ${icon('settings', 'faint')}`);
}

function renderThemeIcon() {
  const btn = root?.querySelector('[data-act="theme"]');
  if (!btn) return;
  const pref = currentThemePref();
  btn.innerHTML = String(icon(pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'monitor'));
  btn.title = `Giao diện: ${pref === 'dark' ? 'Tối' : pref === 'light' ? 'Sáng' : 'Theo hệ thống'}`;
}

function cycleTheme(anchor) {
  popMenu(anchor, [
    { label: 'Sáng', icon: 'sun', onClick: () => { applyTheme('light', { persist: true }); renderThemeIcon(); } },
    { label: 'Tối', icon: 'moon', onClick: () => { applyTheme('dark', { persist: true }); renderThemeIcon(); } },
    { label: 'Theo hệ thống', icon: 'monitor', onClick: () => { applyTheme('system', { persist: true }); renderThemeIcon(); } },
  ]);
}

function renderTimer() {
  const slot = root?.querySelector('[data-timer]');
  if (!slot) return;
  const run = store.get().runningEntry;
  const paused = !run && pausedSession();
  if (!run && !paused) { slot.innerHTML = ''; return; }
  const label = run ? run.task?.title || run.description || 'Không gắn công việc' : `Tạm dừng · ${paused.title || 'Phiên tính giờ'}`;
  mount(slot, html`
    <a class="timer-chip" href="#/time" title="${label}" style="${paused ? 'background:var(--surface-sunk);color:var(--ink)' : ''}">
      <span class="timer-chip__pulse" style="${paused ? 'opacity:.4' : ''}"></span>
      <span class="timer-chip__time" data-timer-text>${clock(sessionSeconds())}</span>
      <span class="timer-chip__task truncate">${label}</span>
    </a>`);
}

function updateTimerText() {
  if (!root) return;
  const el = root.querySelector('[data-timer-text]');
  if (el && store.get().runningEntry) el.textContent = clock(sessionSeconds());
  else renderTimer();
}

export { navigate };
