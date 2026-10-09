import { getTimezone, today, diffDays, parseDay } from './date.js';

let CURRENCY = 'VND';
export function configureFormat({ currency } = {}) { if (currency) CURRENCY = currency; }
export const getCurrency = () => CURRENCY;

const nf = new Intl.NumberFormat('vi-VN');
const nf2 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

export const num = (n) => nf.format(Number(n) || 0);
export const dec = (n) => nf2.format(Number(n) || 0);

export function money(n, { compact = false, sign = false } = {}) {
  const v = Number(n) || 0;
  const opts = { style: 'currency', currency: CURRENCY, maximumFractionDigits: CURRENCY === 'VND' ? 0 : 2 };
  if (compact && Math.abs(v) >= 1e6) Object.assign(opts, { notation: 'compact', maximumFractionDigits: 1 });
  const s = new Intl.NumberFormat('vi-VN', opts).format(v);
  return sign && v > 0 ? '+' + s : s;
}
/** Short money for chart axes: 1,2 tr · 350k */
export function moneyShort(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e9) return dec(v / 1e9) + ' tỷ';
  if (Math.abs(v) >= 1e6) return dec(Math.round(v / 1e5) / 10) + ' tr';
  if (Math.abs(v) >= 1e3) return num(Math.round(v / 1e3)) + 'k';
  return num(v);
}

export function pct(n, digits = 0) {
  return `${(Number(n) || 0).toFixed(digits).replace('.', ',')}%`;
}

/** Minutes → "2g 15p" */
export function minutes(m) {
  m = Math.round(Number(m) || 0);
  if (m < 60) return `${m}p`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}g ${String(r).padStart(2, '0')}p` : `${h}g`;
}
export const hours = (m) => dec(Math.round(((Number(m) || 0) / 60) * 10) / 10) + 'g';

/** Seconds → "01:02:03" */
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

const dtf = (o) => new Intl.DateTimeFormat('vi-VN', { timeZone: getTimezone(), ...o });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Calendar day 'YYYY-MM-DD' → formatted label */
export function day(d, style = 'short') {
  if (!d) return '';
  const o = { timeZone: 'UTC' };
  if (style === 'short') Object.assign(o, { day: 'numeric', month: 'short' });
  if (style === 'medium') Object.assign(o, { day: 'numeric', month: 'short', year: 'numeric' });
  if (style === 'long') Object.assign(o, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (style === 'weekday') Object.assign(o, { weekday: 'long', day: 'numeric', month: 'long' });
  if (style === 'numeric') Object.assign(o, { day: '2-digit', month: '2-digit', year: 'numeric' });
  return cap(new Intl.DateTimeFormat('vi-VN', o).format(parseDay(d)));
}
export function monthLabel(d) {
  const date = parseDay(d.length === 7 ? d + '-01' : d);
  return cap(new Intl.DateTimeFormat('vi-VN', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(date));
}

/** "Hôm nay", "Ngày mai", "Hôm qua", "Thứ Năm", or "12 thg 10" */
export function relDay(d) {
  if (!d) return '';
  const diff = diffDays(d, today());
  if (diff === 0) return 'Hôm nay';
  if (diff === 1) return 'Ngày mai';
  if (diff === -1) return 'Hôm qua';
  if (diff > 1 && diff < 7) return cap(new Intl.DateTimeFormat('vi-VN', { timeZone: 'UTC', weekday: 'long' }).format(parseDay(d)));
  return day(d, diff > 300 || diff < -300 ? 'medium' : 'short');
}

export const time = (instant) => dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
export const dateTime = (instant) => dtf({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));

export function ago(instant) {
  const s = (Date.now() - new Date(instant).getTime()) / 1000;
  if (s < 45) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} ngày trước`;
  return dateTime(instant);
}

/** Vietnamese names put the given name last → use its initial. */
export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].charAt(0).toUpperCase() : '?';
}

/** Parse "1.250.000" / "1,5tr" / "350k" → number (NaN when invalid) */
export function parseMoney(input) {
  if (input == null || input === '') return NaN;
  let s = String(input).trim().toLowerCase().replace(/\s|đ|₫|vnd/g, '');
  let mult = 1;
  if (/(tr|m)$/.test(s)) { mult = 1e6; s = s.replace(/(tr|m)$/, ''); }
  else if (/k$/.test(s)) { mult = 1e3; s = s.replace(/k$/, ''); }
  if (/,/.test(s)) s = s.replace(/\./g, '').replace(',', '.');     // vi-VN: '.' thousands, ',' decimals
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s) * mult;
  return Number.isFinite(n) ? n : NaN;
}
