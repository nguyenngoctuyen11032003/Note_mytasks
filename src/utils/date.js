// Calendar-day helpers. A "day" is an ISO string 'YYYY-MM-DD' in the user's
// own timezone (profiles.timezone) — matching the `date` columns in the DB.

let TZ = 'Asia/Ho_Chi_Minh';
let WEEK_START = 1; // 0 = Sun, 1 = Mon

export function configureDates({ timezone, weekStartsOn } = {}) {
  if (timezone && timezone !== TZ) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone }); // RangeError on an unknown IANA name
      TZ = timezone;
    } catch { /* keep the previous zone rather than break every date on the page */ }
  }
  if (weekStartsOn != null) {
    const w = Number(weekStartsOn);
    if (Number.isInteger(w) && w >= 0 && w <= 6) WEEK_START = w;
  }
}
export const getTimezone = () => TZ;
export const getWeekStart = () => WEEK_START;

// Formatters are cached per timezone (building one costs far more than using it).
const fmts = new Map();
function tzFmt(kind, opts) {
  const key = `${kind}|${TZ}`;
  let f = fmts.get(key);
  if (!f) { f = new Intl.DateTimeFormat(kind === 'day' ? 'en-CA' : 'en-US', { timeZone: TZ, ...opts }); fmts.set(key, f); }
  return f;
}
const dayFmt = () => tzFmt('day', { year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = () => tzFmt('parts', { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Instant (Date | string) → 'YYYY-MM-DD' in the user's timezone. */
export function dayOf(instant) {
  return dayFmt().format(instant instanceof Date ? instant : new Date(instant));
}
export const today = () => dayOf(new Date());

/** Parse 'YYYY-MM-DD' as a UTC-noon Date — safe for pure calendar arithmetic. */
export function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
export function fmtDay(date) {
  return date.toISOString().slice(0, 10);
}
export function addDays(day, n) {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDay(d);
}
export function addMonths(day, n) {
  const d = parseDay(day);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return fmtDay(target);
}
export function diffDays(a, b) {
  return Math.round((parseDay(a) - parseDay(b)) / 86400000);
}
export const weekday = (day) => parseDay(day).getUTCDay();

export function startOfWeek(day) {
  const diff = (weekday(day) - WEEK_START + 7) % 7;
  return addDays(day, -diff);
}
export const endOfWeek = (day) => addDays(startOfWeek(day), 6);
export const startOfMonth = (day) => day.slice(0, 8) + '01';
export function endOfMonth(day) {
  const d = parseDay(startOfMonth(day));
  return fmtDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)));
}
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export const monthKey = (day) => day.slice(0, 7);

/** Offset of the user's zone at instant `ms` (local wall clock − UTC), in ms. */
function offsetAt(ms) {
  const parts = partsFmt().formatToParts(new Date(ms));
  const get = (k) => Number(parts.find((p) => p.type === k).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) - ms;
}

/**
 * Wall-clock time (expressed as a UTC ms value, e.g. Date.UTC(y, m, d, h, mi))
 * → the real instant in the user's timezone. The offset is taken at the
 * candidate instant itself (not at the wall time read as UTC), so DST changes
 * between the two are handled:
 * - ambiguous wall time (clocks go back) → the earlier instant;
 * - skipped wall time (clocks go forward) → the same distance past the jump
 *   (e.g. 00:00 skipped → 01:00).
 */
function wallToInstant(wall) {
  // At most one transition within ±1 day: the offsets on either side are the only candidates.
  const before = offsetAt(wall - 86400000);
  const after = offsetAt(wall + 86400000);
  const hits = [];
  for (const off of new Set([before, after])) if (offsetAt(wall - off) === off) hits.push(wall - off);
  return hits.length ? Math.min(...hits) : wall - before;
}

/** UTC instant of 00:00 on `day` in the user's timezone (for timestamptz queries). */
export function dayStartInstant(day) {
  return new Date(wallToInstant(Date.parse(`${day}T00:00:00Z`)));
}
export const dayEndInstant = (day) => dayStartInstant(addDays(day, 1));

/** Weekday labels starting from the configured first day. */
export function weekdayLabels(style = 'short') {
  const base = style === 'narrow' ? ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] : ['CN', 'Th 2', 'Th 3', 'Th 4', 'Th 5', 'Th 6', 'Th 7'];
  return [...base.slice(WEEK_START), ...base.slice(0, WEEK_START)];
}

/** 'YYYY-MM-DDTHH:mm' for <input type=datetime-local>, in the user's timezone. */
export function toLocalInput(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  const parts = partsFmt().formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${String(Number(g('hour')) % 24).padStart(2, '0')}:${g('minute')}`;
}
/** Inverse of toLocalInput — interprets the value in the user's timezone. */
export function fromLocalInput(value) {
  const [day, time] = value.split('T');
  const [h, m] = time.split(':').map(Number);
  // Offset of the target wall time itself (not of midnight): differs on DST-change days.
  return new Date(wallToInstant(Date.parse(`${day}T00:00:00Z`) + (h * 60 + m) * 60000));
}
