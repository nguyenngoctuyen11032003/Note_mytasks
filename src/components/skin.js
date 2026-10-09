// Visual "skin" — a style layer on top of the light/dark theme.
// 'default' = the Coffee Glass look (no data-skin attribute); every other id
// is a dark liquid-glass skin: 'f1' (theme-f1.css) or one of the twelve
// zodiac palettes 'z-<sign>' (theme-zodiac.css). Device-local only:
// profiles.theme is constrained to light/dark/system, so the skin lives in
// localStorage and index.html applies it before first paint.
import '../css/theme-zodiac.css';
import { applyTheme, currentThemePref } from './theme.js';
import { SIGNS } from '../utils/zodiac.js';

const KEY = 'nm.skin';

/** Swatch colours shown in the Settings picker: [paper, accent]. */
const ZODIAC_SWATCH = {
  aries: ['#13080a', '#ff5a3c'], taurus: ['#06120e', '#3ddc97'], gemini: ['#11100a', '#ffd23f'],
  cancer: ['#0c0e14', '#dfe6f0'], leo: ['#120d05', '#f2b632'], virgo: ['#0b100b', '#a7c98a'],
  libra: ['#130a10', '#ff8fb8'], scorpio: ['#07070c', '#e0355a'], sagittarius: ['#0d0916', '#b48cff'],
  capricorn: ['#100c09', '#d4a373'], aquarius: ['#050e16', '#3fd0ff'], pisces: ['#04101a', '#5ec8e5'],
};

/** { id, label, swatch: [bg, accent], sign? } — base styles first, then the zodiac in calendar order. */
export const SKIN_LIST = [
  { id: 'default', label: 'Coffee Glass', swatch: ['#180a06', '#d99a62'] },
  { id: 'f1', label: 'F1 Night', swatch: ['#0a0e1c', '#edb40b'] },
  ...[...SIGNS.slice(1), SIGNS[0]].map((s) => ({
    id: `z-${s.key}`,
    label: s.name,
    swatch: ZODIAC_SWATCH[s.key],
    sign: s.key,
  })),
];
export const SKIN_IDS = SKIN_LIST.map((s) => s.id);
/** Legacy [id, label] pairs for the base styles (older Settings markup). */
export const SKINS = SKIN_LIST.filter((s) => !s.sign).map((s) => [s.id, s.label]);

const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Albert+Sans:wght@300;400;500;600;700;800&family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap';

export function currentSkin() {
  try {
    const s = localStorage.getItem(KEY);
    return SKIN_IDS.includes(s) ? s : 'default';
  } catch {
    return 'default';
  }
}

/** Fonts are only fetched for viewers who actually pick a glass skin. */
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
  if (skin !== 'default' && SKIN_IDS.includes(skin)) {
    ensureFonts();
    el.dataset.skin = skin;
  } else {
    delete el.dataset.skin;
  }
  if (persist) {
    try { localStorage.setItem(KEY, skin); } catch {}
  }
  // Re-run the theme so meta theme-color and chart listeners pick up the new palette.
  applyTheme(currentThemePref());
}
