import './css/tokens.css';
import './css/base.css';
import './css/layout.css';
import './css/components.css';
import './css/pages.css';

import { isConfigured } from './core/config.js';
import * as store from './core/store.js';
import { current, navigate, onRouteChange } from './core/router.js';
import { html, mount } from './utils/dom.js';
import { configureDates } from './utils/date.js';
import { configureFormat } from './utils/format.js';
import { getSession, onAuthChange, signOut } from './services/auth.js';
import { getProfile } from './services/profile.js';
import { listCategories } from './services/categories.js';
import { mountShell, unmountShell, isMounted, setActive } from './components/shell.js';
import { applyTheme, currentThemePref, onThemeChange } from './components/theme.js';
import { refreshRunning } from './components/timer.js';
import { toast } from './components/toast.js';
import { popMenu } from './components/ui.js';
import { openTaskForm } from './components/taskForm.js';
import { errorState } from './components/states.js';
import { notifyDataChanged } from './core/events.js';

const app = document.getElementById('app');

const PRIVATE = {
  '/dashboard': () => import('./pages/dashboard.js'),
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

async function render() {
  const token = ++renderToken;
  const { path, query } = current();
  const session = store.get().session;

  if (path === RECOVERY) {
    if (!session) return navigate('/forgot-password', null, { replace: true });
    return renderAuthPage('reset', query, token);
  }
  if (PUBLIC.includes(path)) {
    if (session && !recoveryMode) return navigate('/dashboard', null, { replace: true });
    return renderAuthPage(path.slice(1), query, token);
  }
  if (!PRIVATE[path]) {
    return navigate(session ? '/dashboard' : '/login', null, { replace: true });
  }
  if (!session) {
    return navigate('/login', { next: path }, { replace: true });
  }

  if (!isMounted() || !content) {
    content = mountShell(app, { onSignOut: doSignOut, onQuickAdd });
  }
  setActive(path);
  runCleanup();
  content.classList.remove('is-entering');
  content.innerHTML = '';
  void content.offsetWidth;
  content.classList.add('is-entering');
  window.scrollTo({ top: 0 });

  try {
    const mod = await PRIVATE[path]();
    if (token !== renderToken) return;
    cleanup = (await mod.default(content, { query, path })) || null;
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    if (err?.sessionExpired) return expireSession();
    mount(content, errorState(err));
    content.querySelector('[data-act="retry"]')?.addEventListener('click', render);
  }
}

async function renderAuthPage(kind, query, token) {
  runCleanup();
  unmountShell();
  content = null;
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

function onQuickAdd(anchor) {
  popMenu(anchor, [
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
      if (PUBLIC.includes(current().path)) navigate(next && PRIVATE[next] ? next : '/dashboard', null, { replace: true });
      return;
    }
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
      if (s) store.set({ session: s, user: s.user });
    }
  });

  onRouteChange(render);
  // Charts read colours from CSS tokens: re-render the page on theme change.
  onThemeChange(() => { if (isMounted()) render(); });
  render();
}

window.addEventListener('nm:recovery-done', () => {
  recoveryMode = false;
});

boot();
