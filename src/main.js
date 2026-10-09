import './css/tokens.css';
import './css/base.css';
import './css/layout.css';
import './css/components.css';
import './css/pages.css';
import './css/theme.css';
import './css/theme-f1.css';

import { isConfigured } from './core/config.js';
import * as store from './core/store.js';
import { current, navigate, onRouteChange } from './core/router.js';
import { html, mount } from './utils/dom.js';
import { configureDates } from './utils/date.js';
import { configureFormat } from './utils/format.js';
import { getSession, onAuthChange, signOut } from './services/auth.js';
import { getProfile } from './services/profile.js';
import { listCategories } from './services/categories.js';
import { mountShell, unmountShell, isMounted, setActive, focusContent } from './components/shell.js';
import { configurePalette, openPalette } from './components/commandPalette.js';
import { initShortcuts, openShortcutHelp } from './components/shortcuts.js';
import { applyTheme, currentThemePref, onThemeChange } from './components/theme.js';
import { refreshRunning } from './components/timer.js';
import { toast } from './components/toast.js';
import { popMenu } from './components/ui.js';
import { openTaskForm } from './components/taskForm.js';
import { errorState } from './components/states.js';
import { notifyDataChanged } from './core/events.js';
import { initLiquidGlass } from './components/liquidGlass.js';
import { initMotion } from './components/motion.js';
import { applySkin, currentSkin } from './components/skin.js';

const app = document.getElementById('app');

const PRIVATE = {
  '/dashboard': () => import('./pages/dashboard.js'),
  '/notes': () => import('./pages/notes.js'),
  '/tasks': () => import('./pages/tasks.js'),
  '/calendar': () => import('./pages/calendar.js'),
  '/time': () => import('./pages/time.js'),
  '/kpi': () => import('./pages/kpi.js'),
  '/expenses': () => import('./pages/expenses.js'),
  '/shopping': () => import('./pages/shopping.js'),
  '/reports': () => import('./pages/reports.js'),
  '/settings': () => import('./pages/settings.js'),
};
const PUBLIC = ['/login', '/signup', '/forgot-password'];
const RECOVERY = '/reset-password';

let content = null;
let cleanup = null;
let renderToken = 0;
let recoveryMode = false;
let firstPrivateRender = true;

/** Landing page after login and for unknown routes (Settings may store one). */
const HOME_KEY = 'nm.home';
function homePath() {
  try {
    const p = localStorage.getItem(HOME_KEY);
    if (p && PRIVATE[p]) return p;
  } catch {}
  return '/dashboard';
}

/* ------------------------------------------------------------------ */

async function loadUserContext(session) {
  store.set({ session, user: session.user });
  const [profile, categories] = await Promise.all([getProfile(session.user.id), listCategories()]);
  store.set({ profile, categories });
  if (profile) {
    configureDates({ timezone: profile.timezone, weekStartsOn: profile.week_starts_on });
    configureFormat({ currency: profile.currency });
    // Profile is the source of truth for the theme across devices.
    if (profile.theme && profile.theme !== currentThemePref()) applyTheme(profile.theme, { persist: true });
  }
  refreshRunning().catch(() => {});
}

function cleanAuthParams() {
  // PKCE returns ?code=… — remove it after supabase-js has exchanged it.
  const url = new URL(window.location.href);
  if (url.searchParams.has('code') || url.searchParams.has('error') || url.searchParams.has('error_description')) {
    const err = url.searchParams.get('error_description');
    ['code', 'error', 'error_code', 'error_description', 'type'].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(null, '', url);
    if (err) setTimeout(() => toast.error(decodeURIComponent(err.replace(/\+/g, ' '))), 300);
  }
}

/* ------------------------------------------------------------------ */

/** opts.keepScroll — re-render in place (theme change) without moving the reader. */
async function render(opts) {
  const keepScroll = Boolean(opts && opts.keepScroll);
  const token = ++renderToken;
  const { path, query } = current();
  const session = store.get().session;

  if (path === RECOVERY) {
    if (!session) return navigate('/forgot-password', null, { replace: true });
    return renderAuthPage('reset', query, token);
  }
  if (PUBLIC.includes(path)) {
    if (session && !recoveryMode) return navigate(homePath(), null, { replace: true });
    return renderAuthPage(path.slice(1), query, token);
  }
  if (!PRIVATE[path]) {
    return navigate(session ? homePath() : '/login', null, { replace: true });
  }
  if (!session) {
    return navigate('/login', { next: path }, { replace: true });
  }

  if (!isMounted() || !content) {
    content = mountShell(app, { onSignOut: doSignOut, onQuickAdd, onSearch: () => openPalette() });
  }
  setActive(path);
  runCleanup();
  const restoreY = keepScroll ? window.scrollY : scrollTarget();
  content.classList.remove('is-entering');
  content.innerHTML = '';
  void content.offsetWidth;
  if (!keepScroll) content.classList.add('is-entering');
  if (!restoreY) window.scrollTo({ top: 0 });
  content.setAttribute('aria-busy', 'true');

  try {
    const mod = await PRIVATE[path]();
    if (token !== renderToken) return;
    cleanup = (await mod.default(content, { query, path })) || null;
    if (token !== renderToken) return;
    content.removeAttribute('aria-busy');
    if (restoreY) restoreScroll(restoreY, token);
    // Screen readers: announce the new page by focusing its heading — unless
    // the page moved focus itself (deep link opened a dialog, autofocus…).
    const first = firstPrivateRender;
    firstPrivateRender = false;
    if (!first && !keepScroll) {
      const a = document.activeElement;
      const pageTookFocus = document.querySelector('dialog[open]') || (a && content.contains(a) && a.matches('input, textarea, select, [contenteditable]'));
      if (!pageTookFocus) focusContent();
    }
  } catch (err) {
    content.removeAttribute('aria-busy');
    if (token !== renderToken) return;
    console.error(err);
    if (err?.sessionExpired) return expireSession();
    mount(content, errorState(err));
    content.querySelector('[data-act="retry"]')?.addEventListener('click', () => render());
  }
}

async function renderAuthPage(kind, query, token) {
  runCleanup();
  unmountShell();
  content = null;
  firstPrivateRender = true;
  const mod = await import('./pages/auth.js');
  if (token !== renderToken) return;
  document.title = 'Note_mytasks';
  cleanup = mod.default(app, { kind, query }) || null;
}

function runCleanup() {
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (e) { console.error(e); }
  }
  cleanup = null;
}

/** The quick-add button actually on screen (topbar ≥ 768px, tab-bar FAB below). */
function visibleQuickAddAnchor() {
  return [...document.querySelectorAll('[data-act="quick-add"]')].find((b) => b.getClientRects().length) || null;
}

function onQuickAdd(anchor) {
  const a = anchor && anchor.getClientRects().length ? anchor : visibleQuickAddAnchor();
  if (!a) return;
  popMenu(a, [
    { label: 'Ghi chú', icon: 'note', onClick: () => navigate('/notes', { new: '1' }) },
    { label: 'Công việc', icon: 'tasks', onClick: () => openTaskForm({ onSaved: () => notifyDataChanged('tasks') }) },
    { label: 'Khoản chi', icon: 'wallet', onClick: () => navigate('/expenses', { new: '1' }) },
    { label: 'Món cần mua', icon: 'cart', onClick: () => navigate('/shopping', { new: '1' }) },
    { label: 'Ghi giờ thủ công', icon: 'clock', onClick: () => navigate('/time', { new: '1' }) },
    { label: 'Cập nhật KPI', icon: 'target', onClick: () => navigate('/kpi') },
  ]);
}

async function doSignOut() {
  try {
    await signOut();
  } catch (err) {
    toast.error(err);
  }
  store.clearUserState();
  runCleanup();
  navigate('/login', null, { replace: true });
}

function expireSession() {
  store.clearUserState();
  toast.error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  navigate('/login', null, { replace: true });
}
window.addEventListener('nm:session-expired', expireSession);

/* ------------------------------------------------------------------ */

async function boot() {
  applyTheme(currentThemePref());

  if (!isConfigured) {
    mount(app, html`
      <div class="fatal">
        <span class="eyebrow">Cấu hình thiếu</span>
        <h1 style="margin-top:8px">Chưa kết nối Supabase</h1>
        <p class="muted" style="margin-bottom:12px">Tạo file <code>.env</code> ở thư mục gốc với hai biến sau rồi chạy lại <code>npm run dev</code>:</p>
        <p><code>VITE_SUPABASE_URL</code><br /><code>VITE_SUPABASE_ANON_KEY</code></p>
      </div>`);
    return;
  }

  let session = null;
  try {
    session = await getSession();
  } catch (err) {
    toast.error(err);
  }
  cleanAuthParams();

  if (session) {
    try {
      await loadUserContext(session);
    } catch (err) {
      toast.error(err);
    }
  }

  onAuthChange(async (event, s) => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      if (s) store.set({ session: s, user: s.user });
      navigate(RECOVERY, null, { replace: true });
      return;
    }
    if (event === 'SIGNED_OUT') {
      store.clearUserState();
      recoveryMode = false;
      if (!PUBLIC.includes(current().path)) navigate('/login', null, { replace: true });
      return;
    }
    if (event === 'SIGNED_IN' && s && s.user.id !== store.get().user?.id) {
      try {
        await loadUserContext(s);
      } catch (err) {
        toast.error(err);
      }
      cleanAuthParams();
      if (recoveryMode) return;
      const next = current().query.next;
      if (PUBLIC.includes(current().path)) navigate(next && PRIVATE[next] ? next : homePath(), null, { replace: true });
      return;
    }
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
      if (s) store.set({ session: s, user: s.user });
    }
  });

  onRouteChange(() => render());
  // Charts read colours from CSS tokens: re-render the page on theme change.
  onThemeChange(() => { if (isMounted()) render({ keepScroll: true }); });
  render();
}

window.addEventListener('nm:recovery-done', () => {
  recoveryMode = false;
});

/* ------------------------------------------------------------------ */
/* Scroll restoration — each history entry gets a key in history.state;  */
/* the window scroll is remembered per key, so Back/Forward and reload   */
/* return the reader to where they were while new routes start at top.   */

const SCROLL_KEY = 'nm.scroll';
let scrollMemo = {};
try { scrollMemo = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}') || {}; } catch {}
let entryKey = null;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/** Remembered Y for the current history entry (0 → start at the top). */
function scrollTarget() {
  // The window still shows the outgoing page: remember where it was left.
  if (entryKey) scrollMemo[entryKey] = Math.round(window.scrollY);
  const k = history.state && history.state.nmk;
  if (k) {
    entryKey = k;
    return scrollMemo[k] || 0;
  }
  entryKey = Math.random().toString(36).slice(2, 10);
  try { history.replaceState({ ...(history.state || {}), nmk: entryKey }, '', window.location.href); } catch {}
  return 0;
}

function restoreScroll(y, token) {
  // Pages often finish drawing after async data — retry until tall enough.
  const t0 = performance.now();
  const attempt = () => {
    if (token !== renderToken) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: Math.min(y, Math.max(max, 0)) });
    if (max < y && performance.now() - t0 < 1500) setTimeout(attempt, 100);
  };
  requestAnimationFrame(attempt);
}

let scrollSaveQueued = false;
window.addEventListener('scroll', () => {
  if (scrollSaveQueued || !entryKey) return;
  scrollSaveQueued = true;
  setTimeout(() => {
    scrollSaveQueued = false;
    if (entryKey) scrollMemo[entryKey] = Math.round(window.scrollY);
  }, 150);
}, { passive: true });
window.addEventListener('pagehide', () => {
  const keys = Object.keys(scrollMemo);
  if (keys.length > 60) keys.slice(0, keys.length - 60).forEach((k) => delete scrollMemo[k]);
  try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(scrollMemo)); } catch {}
});

/* ------------------------------------------------------------------ */
/* Command palette + global shortcuts                                   */

configurePalette({ onSignOut: () => doSignOut(), onHelp: () => openShortcutHelp() });
initShortcuts({ enabled: () => isMounted(), onQuickAdd: () => onQuickAdd(null) });

/* ------------------------------------------------------------------ */
/* Offline banner                                                       */

function initOfflineBanner() {
  const el = document.createElement('div');
  el.className = 'offline-banner';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<span class="offline-banner__dot" aria-hidden="true"></span><span><strong>Bạn đang ngoại tuyến.</strong> <span class="offline-banner__more">Thay đổi sẽ không được lưu cho đến khi có mạng trở lại.</span></span>';
  document.body.append(el);
  let wasOffline = false;
  const sync = () => {
    const offline = navigator.onLine === false;
    el.classList.toggle('is-on', offline);
    document.body.classList.toggle('is-offline', offline);
    if (!offline && wasOffline) toast.info('Đã kết nối lại.');
    wasOffline = offline;
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  sync();
}

/* ------------------------------------------------------------------ */
/* Service worker — production only, relative URL keeps the /<repo>/ scope */

function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  let accepted = false;
  let offered = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only after the user chose "Tải lại" — never on the very first install.
    if (accepted) window.location.reload();
  });
  const offer = (worker) => {
    if (offered || !worker) return;
    offered = true;
    toast.info('Đã có phiên bản mới.', {
      duration: 0,
      action: {
        label: 'Tải lại',
        onClick: () => {
          accepted = true;
          worker.postMessage({ type: 'SKIP_WAITING' });
        },
      },
    });
  };
  window.addEventListener('load', async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register(new URL('./sw.js', window.location.href));
    } catch (err) {
      console.warn('Service worker registration failed', err);
      return;
    }
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Precache what this first load actually used (the worker also precaches
    // the build's file list at install time).
    navigator.serviceWorker.ready.then((r) => {
      const urls = performance.getEntriesByType('resource').map((e) => e.name);
      r.active?.postMessage({ type: 'CACHE_URLS', urls });
    }).catch(() => {});
    // Long-lived tabs: check for a new deploy when the app returns to front.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  });
}

applySkin(currentSkin());
initOfflineBanner();
registerServiceWorker();
boot();
initLiquidGlass();
initMotion();
