// Current user's profile (profiles.id = auth user id).
import { db, run, invalid, pick, requireNonEmpty, vText, vNumber, vEnum, vUrl, AppError } from './errors.js';

export const PROFILE_COLS = 'id, display_name, avatar_url, currency, locale, timezone, week_starts_on, theme, created_at, updated_at';
export const PROFILE_WRITABLE = ['display_name', 'currency', 'locale', 'timezone', 'week_starts_on', 'theme', 'avatar_url'];
export const THEMES = ['light', 'dark', 'system'];

// Postgres (profiles_validate_timezone → pg_timezone_names) matches names exactly,
// while Intl also accepts lower-case names and "+07:00"-style offsets. Require the
// canonical IANA shape first ("Asia/Ho_Chi_Minh", "UTC", "Etc/GMT+7") so a value
// that passes here can't fail on the server.
const IANA_SHAPE = /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)*$/;

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !IANA_SHAPE.test(tz)) return false;
  try {
    if (typeof Intl.supportedValuesOf === 'function' && Intl.supportedValuesOf('timeZone').includes(tz)) return true;
  } catch { /* fall through */ }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateProfile(input) {
  const p = pick(input, PROFILE_WRITABLE);
  if ('display_name' in p) p.display_name = vText(p.display_name, 'display_name', { max: 80, label: 'Tên hiển thị' });
  if ('currency' in p) {
    const c = String(p.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw invalid('currency', 'Mã tiền tệ gồm 3 chữ cái (vd VND).');
    p.currency = c;
  }
  if ('locale' in p) {
    const l = vText(p.locale, 'locale', { required: true, max: 35, label: 'Ngôn ngữ' });
    try {
      [p.locale] = Intl.getCanonicalLocales(l);
    } catch {
      throw invalid('locale', 'Ngôn ngữ không hợp lệ.');
    }
  }
  if ('timezone' in p) {
    const tz = vText(p.timezone, 'timezone', { required: true, label: 'Múi giờ' });
    if (!isValidTimezone(tz)) throw invalid('timezone', 'Múi giờ không hợp lệ.');
    p.timezone = tz;
  }
  if ('week_starts_on' in p) p.week_starts_on = vNumber(p.week_starts_on, 'week_starts_on', { required: true, min: 0, max: 6, integer: true, label: 'Ngày đầu tuần' });
  if ('theme' in p) p.theme = vEnum(p.theme, 'theme', THEMES, { required: true, label: 'Giao diện' });
  if ('avatar_url' in p) p.avatar_url = vUrl(p.avatar_url, 'avatar_url', { label: 'Ảnh đại diện' });
  return p;
}

async function currentUserId() {
  const { session } = (await run(db().auth.getSession())) || {};
  const id = session?.user?.id;
  if (!id) throw new AppError('session_expired');
  return id;
}

export async function get() {
  const id = await currentUserId();
  return run(db().from('profiles').select(PROFILE_COLS).eq('id', id).maybeSingle());
}

export async function update(patch) {
  const row = requireNonEmpty(validateProfile(patch));
  const id = await currentUserId();
  return run(db().from('profiles').update(row).eq('id', id).select(PROFILE_COLS).single());
}

/** Compat: getProfile(userId?) — defaults to the signed-in user. */
export async function getProfile(userId) {
  const id = typeof userId === 'string' && userId ? userId : await currentUserId();
  return run(db().from('profiles').select(PROFILE_COLS).eq('id', id).maybeSingle());
}

/* ------------------------------------------------------------------ */
/* Device-local preferences (no DB column): avatar colour, landing page */
/* ------------------------------------------------------------------ */

const AVATAR_KEY = 'nm.avatarColor';
const HOME_KEY = 'nm.home';
export const HOME_PAGES = [
  { path: '/dashboard', label: 'Tổng quan' },
  { path: '/notes', label: 'Ghi chú' },
  { path: '/tasks', label: 'Công việc' },
  { path: '/calendar', label: 'Lịch' },
  { path: '/time', label: 'Thời gian' },
  { path: '/kpi', label: 'KPI' },
  { path: '/expenses', label: 'Chi tiêu' },
  { path: '/shopping', label: 'Mua sắm' },
  { path: '/reports', label: 'Báo cáo' },
];

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

/** Avatar initials colour ('#RRGGBB') or null = default ink. */
export function getAvatarColor() {
  const c = lsGet(AVATAR_KEY);
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}

/** Exposes the colour as CSS vars --avatar-bg / --avatar-fg (used by .avatar). */
export function applyAvatarColor(color = getAvatarColor()) {
  if (typeof document === 'undefined') return;
  const s = document.documentElement.style;
  if (color) {
    s.setProperty('--avatar-bg', color);
    s.setProperty('--avatar-fg', 'var(--accent-contrast)');
  } else {
    s.removeProperty('--avatar-bg');
    s.removeProperty('--avatar-fg');
  }
}

export function setAvatarColor(color) {
  const c = color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  lsSet(AVATAR_KEY, c);
  applyAvatarColor(c);
  return c;
}

/** Default landing page after sign-in (localStorage 'nm.home', read by the shell). */
export function getHomePage() {
  const p = lsGet(HOME_KEY);
  return HOME_PAGES.some((h) => h.path === p) ? p : '/dashboard';
}
export function setHomePage(path) {
  const p = HOME_PAGES.some((h) => h.path === path) ? path : '/dashboard';
  lsSet(HOME_KEY, p);
  return p;
}

// Boot: this module is loaded at start-up, so the saved avatar colour shows
// everywhere without the shell having to know about it.
applyAvatarColor();

/** Compat: updateProfile(userId, patch) or updateProfile(patch). */
export async function updateProfile(userId, patch) {
  if (userId && typeof userId === 'object') return update(userId);
  // (userId, patch): userId is ignored — RLS scopes the row to the signed-in user.
  return update(patch);
}
