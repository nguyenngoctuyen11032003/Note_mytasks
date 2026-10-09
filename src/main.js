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
import { getSession, onAuthChange, signOut, verifyEmailLink } from './services/auth.js';
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
import { errorState, loadingRows } from './components/states.js';
import { notifyDataChanged } from './core/events.js';
import { initLiquidGlass } from './components/liquidGlass.js';
import { enterContent } from './components/motion.js';
import { applySkin, currentSkin } from './components/skin.js';
import './css/perf.css'; // last: performance overrides must beat the skins (skin.js pulls in theme-zodiac.css)

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
/** Pages that redraw their own charts on onThemeChange (no full re-render needed). */
const SELF_THEMED = new Set(['/expenses', '/reports', '/time']);

/* Route chunks: import() is memoised, so a prefetch is just an early call. */
const loadAuthPage = () => import('./pages/auth.js');
function prefetchRoute(path) {
  const load = PRIVATE[path] || (PUBLIC.includes(path) || path === '/reset-password' ? loadAuthPage : null);
  load?.().catch(() => {}); // a real navigation retries and shows the error
}

/** Warm the remaining pages once the first one is up — one per idle slot, never on data saver. */
function prefetchIdle() {
  const c = navigator.connection;
  if (c && (c.saveData || /2g/.test(c.effectiveType || ''))) return;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
  const queue = Object.keys(PRIVATE);
  const next = () => {
    const p = queue.shift();
    if (!p) return;
    prefetchRoute(p);
    idle(next, { timeout: 4000 });
  };
  idle(next, { timeout: 4000 });
}

/** Hover / touch / focus on an in-app link → start loading that page before the click lands. */
function prefetchOnIntent(e) {
  const a = e.target.closest?.('a[href^="#/"]');
  if (a) prefetchRoute(a.getAttribute('href').slice(1).split('?')[0]);
}
['pointerover', 'touchstart', 'focusin'].forEach((t) => document.addEventListener(t, prefetchOnIntent, { passive: true }));
const RECOVERY = '/reset-password';

let content = null;
let cleanup = null;
// Aborted on every navigation: pages tie their listeners to this signal
// (core/events.js disposeOnAbort), so a page interrupted mid-load or one that
// threw still releases them — not only pages that returned a cleanup.
let pageAbort = null;
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

/*
 * User context cache: profile + categories of the last signed-in user, kept in
 * localStorage (wiped on sign-out, see store.clearUserState). Boot paints the
 * first page from it at once instead of waiting a network round trip, then
 * revalidates in the background and re-renders only if something that changes
 * the rendering (timezone, week start, currency, categories) differs.
 */
const CTX_KEY = 'nm.ctx';
function readCtx(uid) {
  try {
    const c = JSON.parse(localStorage.getItem(CTX_KEY) || 'null');
    return c && c.uid === uid && c.profile ? c : null;
  } catch { return null; }
}
function writeCtx(uid, profile, categories) {
  try { localStorage.setItem(CTX_KEY, JSON.stringify({ uid, profile, categories })); } catch { /* quota / private mode */ }
}
// Settings / category edits update the store: keep the cache in step.
store.subscribe((s, patch) => {
  if (('profile' in patch || 'categories' in patch) && s.user && s.profile) writeCtx(s.user.id, s.profile, s.categories);
});
const renderKey = (profile, categories) => JSON.stringify([profile?.timezone, profile?.week_starts_on, profile?.currency, categories]);

function applyCtx(profile, categories) {
  store.set({ profile, categories });
  if (profile) {
    configureDates({ timezone: profile.timezone, weekStartsOn: profile.week_starts_on });
    configureFormat({ currency: profile.currency });
    // Profile is the source of truth for the theme across devices.
    if (profile.theme && profile.theme !== currentThemePref()) applyTheme(profile.theme, { persist: true });
  }
}

async function loadUserContext(session) {
  store.set({ session, user: session.user });
  const uid = session.user.id;
  const cached = readCtx(uid);
  const fresh = Promise.all([getProfile(uid), listCategories()]).then(([profile, categories]) => {
    writeCtx(uid, profile, categories);
    return { profile, categories };
  });
  refreshRunning().catch(() => {});
  if (!cached) {
    const { profile, categories } = await fresh;
    applyCtx(profile, categories);
    return;
  }
  applyCtx(cached.profile, cached.categories || []);
  fresh.then(({ profile, categories }) => {
    if (store.get().user?.id !== uid) return; // signed out / switched meanwhile
    const changed = renderKey(profile, categories) !== renderKey(cached.profile, cached.categories || []);
    applyCtx(profile, categories);
    if (changed && isMounted()) render({ keepScroll: true });
  }).catch((err) => { if (err?.sessionExpired) expireSession(); });
}

const AUTH_ERRORS = {
  otp_expired: 'Liên kết trong email đã hết hạn hoặc đã được dùng. Hãy yêu cầu gửi lại liên kết mới.',
  access_denied: 'Liên kết không còn hợp lệ. Hãy yêu cầu gửi lại liên kết mới.',
};

function cleanAuthParams() {
  // PKCE returns ?code=… — remove it after supabase-js has exchanged it.
  // Supabase reports link errors either as ?error=… or as #error=… (implicit
  // style); the hash form would otherwise be read as a route by the router.
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#\/?/, ''));
  const hashError = hash.has('error') || hash.has('error_code');
  if (url.searchParams.has('code') || url.searchParams.has('error') || url.searchParams.has('error_description') || hashError) {
    const code = url.searchParams.get('error_code') || hash.get('error_code') || url.searchParams.get('error') || hash.get('error');
    const raw = url.searchParams.get('error_description') || hash.get('error_description');
    ['code', 'error', 'error_code', 'error_description', 'type', 'flow'].forEach((k) => url.searchParams.delete(k));
    if (hashError) url.hash = '';
    window.history.replaceState(null, '', url);
    const msg = AUTH_ERRORS[code] || (raw ? decodeURIComponent(raw.replace(/\+/g, ' ')) : null);
    if (msg) {
      setTimeout(() => toast.error(msg), 300);
      if (code === 'otp_expired' || code === 'access_denied') navigate('/forgot-password', null, { replace: true });
    }
  }
}

/** token_hash links from the custom email templates (supabase/templates/*.html). */
function emailLinkParams() {
  const search = Object.fromEntries(new URL(window.location.href).searchParams);
  const q = { ...search, ...current().query };
  return q.token_hash && q.type ? { tokenHash: q.token_hash, type: q.type } : null;
}

/**
 * Spends a token_hash link: recovery → reset-password page, sign-up
 * confirmation → signed in. Returns the resulting session (or the old one).
 */
async function handleEmailLink({ tokenHash, type }, session) {
  // Strip the token from the address bar first so a reload never re-submits it.
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  window.history.replaceState(null, '', url);
  try {
    const data = await verifyEmailLink(tokenHash, type);
    const s = data?.session || null;
    if (type === 'recovery') {
      recoveryMode = true;
      if (s) store.set({ session: s, user: s.user });
      navigate(RECOVERY, null, { replace: true });
    } else {
      setTimeout(() => toast('Đã xác nhận email. Chào mừng bạn đến với Stratos!'), 300);
      navigate(s ? homePath() : '/login', null, { replace: true });
    }
    return s || session;
  } catch (err) {
    setTimeout(() => toast.error(err), 300);
    navigate(type === 'recovery' ? '/forgot-password' : '/login', null, { replace: true });
    return session;
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
    if (!session) return navigate('/login', null, { replace: true });
    if (path === '/' || path === '') return navigate(homePath(), null, { replace: true });
    // Unknown route for a signed-in user: show the 404 page inside the shell.
    if (!isMounted() || !content) {
      content = mountShell(app, { onSignOut: doSignOut, onQuickAdd, onSearch: () => openPalette() });
    }
    setActive(path);
    runCleanup();
    content.removeAttribute('aria-busy');
    const { renderNotFound } = await import('./pages/auth.js');
    if (token !== renderToken) return;
    renderNotFound(content, { path, home: homePath() });
    return;
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
  // Theme re-render: keep the old page on screen until the new one replaces it (no flash).
  if (!keepScroll) {
    content.innerHTML = '';
    enterContent(content);
  }
  if (!restoreY) window.scrollTo({ top: 0 });
  content.setAttribute('aria-busy', 'true');

  // A page chunk that is not cached yet: show a skeleton instead of a blank
  // screen if it takes longer than a blink.
  const skeleton = keepScroll ? null : setTimeout(() => {
    if (token === renderToken && !content.firstChild) mount(content, html`<div class="page-loading">${loadingRows(6)}</div>`);
  }, 120);

  try {
    const mod = await PRIVATE[path]();
    clearTimeout(skeleton);
    if (token !== renderToken) return;
    if (!keepScroll) content.innerHTML = '';
    pageAbort = new AbortController();
    const dispose = (await mod.default(content, { query, path, signal: pageAbort.signal })) || null;
    // A newer navigation started while this page was loading: tear this page
    // down now, otherwise its listeners outlive it and the newer page's
    // disposer could be overwritten.
    if (token !== renderToken) {
      try { if (typeof dispose === 'function') dispose(); } catch (e) { console.error(e); }
      return;
    }
    cleanup = dispose;
    content.removeAttribute('aria-busy');
    if (restoreY) restoreScroll(restoreY, token);
    // Screen readers: announce the new page by focusing its heading — unless
    // the page moved focus itself (deep link opened a dialog, autofocus…).
    const first = firstPrivateRender;
    firstPrivateRender = false;
    if (first) prefetchIdle();
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
  const mod = await loadAuthPage();
  if (token !== renderToken) return;
  document.title = 'Stratos';
  cleanup = mod.default(app, { kind, query }) || null;
}

function runCleanup() {
  // Abort first: it empties the page's disposers, so the explicit cleanup
  // below can't run them a second time.
  pageAbort?.abort();
  pageAbort = null;
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
  // The tab-bar FAB sits mid-screen: centre the menu over it.
  const align = a.closest('.topbar') ? 'end' : 'center';
  popMenu(a, [
    { label: 'Ghi chú', icon: 'note', onClick: () => navigate('/notes', { new: '1' }) },
    { label: 'Công việc', icon: 'tasks', onClick: () => openTaskForm({ onSaved: () => notifyDataChanged('tasks') }) },
    { label: 'Khoản chi', icon: 'wallet', onClick: () => navigate('/expenses', { new: '1' }) },
    { label: 'Món cần mua', icon: 'cart', onClick: () => navigate('/shopping', { new: '1' }) },
    { label: 'Ghi giờ thủ công', icon: 'clock', onClick: () => navigate('/time', { new: '1' }) },
    { label: 'Cập nhật KPI', icon: 'target', onClick: () => navigate('/kpi') },
  ], { align });
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

  // Download the landing page's chunk while the session / profile requests are
  // in flight, instead of only after them (boot was a strict waterfall).
  const p0 = current().path;
  prefetchRoute(p0 === '/' || p0 === '' ? homePath() : p0);

  let session = null;
  try {
    session = await getSession();
  } catch (err) {
    toast.error(err);
  }
  const emailLink = emailLinkParams();
  if (emailLink) session = await handleEmailLink(emailLink, session);
  // Legacy PKCE recovery link (?flow=recovery&code=…): supabase-js already
  // exchanged the code inside getSession(), firing PASSWORD_RECOVERY before
  // we subscribed — route to the reset page from the flow marker instead.
  const params = new URL(window.location.href).searchParams;
  if (!emailLink && params.get('flow') === 'recovery' && params.has('code') && session) {
    recoveryMode = true;
    navigate(RECOVERY, null, { replace: true });
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
  // Everything styled by CSS tokens follows a theme change by itself. Only
  // canvas charts bake colours in at draw time; pages that redraw their own
  // charts on onThemeChange are left alone, the rest (with a chart on screen)
  // re-render. Previously every page refetched all its data on a theme flip.
  onThemeChange(() => {
    if (!isMounted() || !content || SELF_THEMED.has(current().path)) return;
    if (content.querySelector('canvas')) render({ keepScroll: true });
  });
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

