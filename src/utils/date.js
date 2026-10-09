// Calendar-day helpers. A "day" is an ISO string 'YYYY-MM-DD' in the user's
// own timezone (profiles.timezone) — matching the `date` columns in the DB.

let TZ = 'Asia/Ho_Chi_Minh';
let WEEK_START = 1; // 0 = Sun, 1 = Mon

export function configureDates({ timezone, weekStartsOn } = {}) {
  if (timezone) TZ = timezone;
  if (weekStartsOn != null) WEEK_START = Number(weekStartsOn);
}
export const getTimezone = () => TZ;
export const getWeekStart = () => WEEK_START;

const dayFmt = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

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

/** UTC instant of 00:00 on `day` in the user's timezone (for timestamptz queries). */
export function dayStartInstant(day) {
  const guess = new Date(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(guess);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const offset = asLocal - guess.getTime();
  return new Date(guess.getTime() - offset);
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
/** Inverse of toLocalInput — interprets the value in the user's timezone. */
export function fromLocalInput(value) {
  const [day, time] = value.split('T');
  const [h, m] = time.split(':').map(Number);
  return new Date(dayStartInstant(day).getTime() + (h * 60 + m) * 60000);
}
