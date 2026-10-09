import { getTimezone, today, diffDays, parseDay } from './date.js';

// Every formatter is total: null / undefined / malformed input gives '' (or a
// neutral value) instead of throwing, so one bad row never breaks a whole page.

let CURRENCY = 'VND';
export function configureFormat({ currency } = {}) {
  if (!currency) return;
  try {
    new Intl.NumberFormat('vi-VN', { style: 'currency', currency }); // validates the ISO code
    CURRENCY = currency;
  } catch { /* unknown currency code: keep the previous one */ }
}
export const getCurrency = () => CURRENCY;

const nf = new Intl.NumberFormat('vi-VN');
const nf2 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

const finite = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };

export const num = (n) => nf.format(finite(n));
export const dec = (n) => nf2.format(finite(n));

// Intl formatters are expensive to build: cache them by options (+ timezone).
const fmtCache = new Map();
function cached(key, make) {
  let f = fmtCache.get(key);
  if (!f) {
    if (fmtCache.size > 200) fmtCache.clear();
    f = make();
    fmtCache.set(key, f);
  }
  return f;
}

export function money(n, { compact = false, sign = false } = {}) {
  const v = finite(n);
  const isCompact = compact && Math.abs(v) >= 1e6;
  const f = cached(`money|${CURRENCY}|${isCompact}`, () => new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: CURRENCY,
    maximumFractionDigits: isCompact ? 1 : CURRENCY === 'VND' ? 0 : 2,
    ...(isCompact ? { notation: 'compact' } : {}),
  }));
  const s = f.format(v);
  return sign && v > 0 ? '+' + s : s;
}
/** Short money for chart axes: 1,2 tr · 350k */
export function moneyShort(n) {
  const v = finite(n);
  if (Math.abs(v) >= 1e9) return dec(v / 1e9) + ' tỷ';
  if (Math.abs(v) >= 1e6) return dec(Math.round(v / 1e5) / 10) + ' tr';
  if (Math.abs(v) >= 1e3) return num(Math.round(v / 1e3)) + 'k';
  return num(v);
}

export function pct(n, digits = 0) {
  return `${finite(n).toFixed(digits).replace('.', ',')}%`;
}

/** Minutes → "2g 15p" */
export function minutes(m) {
  m = Math.round(finite(m));
  const neg = m < 0 ? '-' : '';
  m = Math.abs(m);
  if (m < 60) return `${neg}${m}p`;
  const h = Math.floor(m / 60), r = m % 60;
  return neg + (r ? `${h}g ${String(r).padStart(2, '0')}p` : `${h}g`);
}
export const hours = (m) => dec(Math.round((finite(m) / 60) * 10) / 10) + 'g';

/** Seconds → "01:02:03" */
export function clock(sec) {
  sec = Math.max(0, Math.floor(finite(sec)));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

const dtf = (o) => {
  const tz = getTimezone();
  return cached(`dt|${tz}|${JSON.stringify(o)}`, () => {
    try { return new Intl.DateTimeFormat('vi-VN', { timeZone: tz, ...o }); } catch { return new Intl.DateTimeFormat('vi-VN', o); }
  });
};
const utcFmt = (o) => cached(`utc|${JSON.stringify(o)}`, () => new Intl.DateTimeFormat('vi-VN', { timeZone: 'UTC', ...o }));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Instant (Date | ISO string | ms) → Date, or null when missing / invalid. */
function toDate(instant) {
  if (instant == null || instant === '') return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** 'YYYY-MM-DD' (or a longer ISO string starting with one) → UTC-noon Date, or null. */
function toDay(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const date = parseDay(d.slice(0, 10));
  return Number.isNaN(date.getTime()) ? null : date;
}

const DAY_STYLES = {
  short: { day: 'numeric', month: 'short' },
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  weekday: { weekday: 'long', day: 'numeric', month: 'long' },
  numeric: { day: '2-digit', month: '2-digit', year: 'numeric' },
};

/** Calendar day 'YYYY-MM-DD' → formatted label ('' when missing / invalid). */
export function day(d, style = 'short') {
  const date = toDay(d);
  if (!date) return '';
  return cap(utcFmt(DAY_STYLES[style] || {}).format(date));
}
export function monthLabel(d) {
  const date = toDay(typeof d === 'string' && d.length === 7 ? d + '-01' : d);
  if (!date) return '';
  return cap(utcFmt({ month: 'long', year: 'numeric' }).format(date));
}

/** "Hôm nay", "Ngày mai", "Hôm qua", "Thứ Năm", or "12 thg 10" */
export function relDay(d) {
  const date = toDay(d);
  if (!date) return '';
  const diff = diffDays(d.slice(0, 10), today());
  if (diff === 0) return 'Hôm nay';
  if (diff === 1) return 'Ngày mai';
  if (diff === -1) return 'Hôm qua';
  if (diff > 1 && diff < 7) return cap(utcFmt({ weekday: 'long' }).format(date));
  return day(d, diff > 300 || diff < -300 ? 'medium' : 'short');
}

export const time = (instant) => {
  const d = toDate(instant);
  return d ? dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) : '';
};
export const dateTime = (instant) => {
  const d = toDate(instant);
  return d ? dtf({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) : '';
};

export function ago(instant) {
  const d = toDate(instant);
  if (!d) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} ngày trước`;
  return dateTime(d);
}

/** Vietnamese names put the given name last → use its initial. */
export function initials(name = '') {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[parts.length - 1])[0] || '?'; // whole code point (emoji-safe)
  return first.toUpperCase();
}

/** Parse "1.250.000" / "1,5tr" / "350k" / "1,250,000" → number (NaN when invalid) */
export function parseMoney(input) {
  if (input == null || input === '') return NaN;
  let s = String(input).trim().toLowerCase().replace(/\s|đ|₫|vnd/g, '');
  let mult = 1;
  if (/(tr|m)$/.test(s)) { mult = 1e6; s = s.replace(/(tr|m)$/, ''); }
  else if (/k$/.test(s)) { mult = 1e3; s = s.replace(/k$/, ''); }
  if (/^\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');   // en-US grouping: 1,250,000(.5)
  else if (/,/.test(s)) s = s.replace(/\./g, '').replace(',', '.');      // vi-VN: '.' thousands, ',' decimals
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (s === '' || s === '.' || s === '-') return NaN;
  const n = Number(s) * mult;
  return Number.isFinite(n) ? n : NaN;
}
