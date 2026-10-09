// Current user's profile (profiles.id = auth user id).
import { db, run, invalid, pick, requireNonEmpty, vText, vNumber, vEnum, vUrl, AppError } from './errors.js';

export const PROFILE_COLS = 'id, display_name, avatar_url, currency, locale, timezone, week_starts_on, theme, created_at, updated_at';
export const PROFILE_WRITABLE = ['display_name', 'currency', 'locale', 'timezone', 'week_starts_on', 'theme', 'avatar_url'];
export const THEMES = ['light', 'dark', 'system'];

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
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

/** Compat: updateProfile(userId, patch) or updateProfile(patch). */
export async function updateProfile(userId, patch) {
  if (userId && typeof userId === 'object') return update(userId);
  // (userId, patch): userId is ignored — RLS scopes the row to the signed-in user.
  return update(patch);
}
