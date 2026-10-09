// Visual "skin" — a style layer on top of the light/dark theme.
// 'default' = the Coffee Glass look; 'f1' = night-race liquid glass
// (src/css/theme-f1.css). Device-local only: profiles.theme is constrained to
// light/dark/system, so the skin lives in localStorage and is applied before
// the first private render (main.js) to keep the flash short.
import { applyTheme, currentThemePref } from './theme.js';

const KEY = 'nm.skin';
export const SKINS = [
  ['default', 'Coffee Glass'],
  ['f1', 'F1 Night'],
];

const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Albert+Sans:wght@300;400;500;600;700;800&family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap';

export function currentSkin() {
  try {
    const s = localStorage.getItem(KEY);
    return SKINS.some(([v]) => v === s) ? s : 'default';
  } catch {
    return 'default';
  }
}

/** Fonts are only fetched for viewers who actually pick the F1 skin. */
function ensureFonts() {
  if (document.getElementById('nm-skin-fonts')) return;
  const link = document.createElement('link');
  link.id = 'nm-skin-fonts';
  link.rel = 'stylesheet';
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

export function applySkin(skin = 'default', { persist = false } = {}) {
  const el = document.documentElement;
  if (skin === 'f1') {
    ensureFonts();
    el.dataset.skin = 'f1';
  } else {
    delete el.dataset.skin;
  }
  if (persist) {
    try { localStorage.setItem(KEY, skin); } catch {}
  }
  // Re-run the theme so meta theme-color and chart listeners pick up the new palette.
  applyTheme(currentThemePref());
}
