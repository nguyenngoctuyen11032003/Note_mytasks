// Theme preference: 'light' | 'dark' | 'system'. Stored in profiles.theme
// (synced from Settings) and mirrored to localStorage for a flash-free boot.
const KEY = 'nm.theme';
const listeners = new Set();

export function currentThemePref() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function applyTheme(pref = 'system', { persist = false } = {}) {
  const el = document.documentElement;
  if (pref === 'light' || pref === 'dark') el.dataset.theme = pref;
  else delete el.dataset.theme;
  if (persist) {
    try { localStorage.setItem(KEY, pref); } catch {}
  }
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  const bg = getComputedStyle(el).getPropertyValue('--paper').trim();
  meta.forEach((m) => m.setAttribute('content', bg));
  listeners.forEach((fn) => fn(pref));
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (currentThemePref() === 'system') applyTheme('system');
});
