// Expense quick-entry parser: "grab 120.000 hôm qua momo" →
//   { amount: 120000, description: 'grab', spent_on: <yesterday>, payment_method: 'e_wallet' }
//
// Rules (documented choices):
// - Amount units: k / nghìn / ngàn (×1e3, "1k5" = 1 500), tr / triệu / m (×1e6, "1tr2" =
//   1 200 000, "1tr250" = 1 250 000, "1,5tr" = "1.5tr" = 1 500 000), tỷ (×1e9); optional
//   trailing đ / đồng / vnd / ₫. Grouped numbers "120.000" / "120,000" / "1.250.000" are
//   literal. A bare integer < 1000 with no unit is read as thousands of VND ("phở 50" =
//   50 000) — nobody records a 50 đ expense; ≥ 1000 is literal. An explicit "đ" keeps
//   the literal value ("500đ" = 500).
// - When several numbers appear the strongest wins (explicit unit > grouped > bare),
//   then the LAST one ("Mua 3 cái bánh 45k" → 45 000, "3" stays in the description).
//   Bare numbers followed by a quantity word ("3 ly", "2 kg") are never amounts.
// - Dates: hôm nay/hnay; hôm qua/hqua/tối qua… (−1); hôm kia/hkia (−2); "N ngày trước";
//   "thứ X" = most recent such day on or before today ("thứ X tuần trước" = last week);
//   dd/mm[/yyyy]: without a year → most recent past occurrence (an expense is not in the
//   future). Invalid dates are ignored. Default spent_on = today.
// - Payment: tiền mặt/tm/cash → cash; ck/chuyển khoản/bank/banking/ngân hàng/stk → bank;
//   thẻ/thẻ tín dụng/visa/master/credit/jcb → credit_card; momo/zalopay/zalo pay/vnpay/
//   shopeepay/viettel money/ví (điện tử) → e_wallet. Leading "bằng/qua/trả bằng" is
//   removed with it. payment_method is null when not mentioned (caller default 'cash').
// - amount is null when no number is found; description = what remains (original casing).

import { addDays, weekday } from '../../utils/date.js';
import { Scanner, B, E, accentOk, isoDay, validYmd, mondayOf, resolveToday } from './text.js';

const MAX_AMOUNT = 1e12;

// ---- numbers -----------------------------------------------------------------------

const GROUPED = /^\d{1,3}(?:[.,]\d{3})+$/;
/** "1,5" / "1.5" → 1.5 ; "1.250" / "120,000" → 1250 / 120000 ; "35" → 35 */
function num(s, { grouped = true } = {}) {
  if (grouped && GROUPED.test(s)) return Number(s.replace(/[.,]/g, ''));
  return Number(s.replace(',', '.'));
}
/** "2" → 0.2, "25" → 0.25, "250" → 0.25, "05" → 0.05 */
const frac = (digits) => (digits ? Number('0.' + digits) : 0);

const QUANTITY_WORDS = [
  'cai', 'chiec', 'ly', 'coc', 'hop', 'goi', 'chai', 'lon', 'kg', 'g', 'gr', 'gram', 'lit', 'l', 'ml',
  'nguoi', 'lan', 'phan', 'suat', 'to', 'dia', 'bat', 'cuon', 'quyen', 'doi', 'bo', 'thung',
  've', 'km', 'buoi', 'thang', 'ngay', 'tuan', 'nam', 'gio', 'phut', 'tieng', 'qua', 'trai',
  'con', 'bich', 'tui', 'cay', 'mieng', 'lat', 'cap', 'so', 'tang', 'phong', 'sp', 'mon', 'x',
  'hu', 'vi', 'tep', 'bao', 'ban', 'chuong', 'trang', 'loai', 'canh', 'hat', 'chuc',
];
const QUANTITY_AFTER = new RegExp(`^\\s*(?:${QUANTITY_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'u');

const NUM_START = '(?<![\\p{L}\\p{N}.,/-])';
const CURRENCY = '(?:\\s*(?:d|dong|vnd)(?![\\p{L}\\p{N}])|\\s*₫)';
const AMOUNT_RULES = [
  { // millions: 1tr, 1tr2, 1tr250, 1,5tr, 2 triệu, 3m
    rank: 3,
    re: `${NUM_START}(\\d+(?:[.,]\\d+)?)(?:\\s*(?:tr|trieu)|m)(?:(\\d{1,3})(?!\\p{N}))?${CURRENCY}?${E}`,
    fn: (m) => (num(m[1], { grouped: false }) + frac(m[2])) * 1e6,
  },
  { // billions
    rank: 3,
    re: `${NUM_START}(\\d+(?:[.,]\\d+)?)\\s*(?:ty|ti)${E}`,
    fn: (m) => num(m[1], { grouped: false }) * 1e9,
  },
  { // thousands: 35k, 35K, 35kđ, 1k5, 50 nghìn/ngàn
    rank: 3,
    re: `${NUM_START}(\\d+(?:[.,]\\d+)?)(?:\\s*(?:k|nghin|ngan))(?:(\\d{1,3})(?!\\p{N}))?${CURRENCY}?${E}`,
    fn: (m) => (num(m[1], { grouped: false }) + frac(m[2])) * 1e3,
  },
  { // explicit currency: 35.000đ, 35000 đồng, 500đ
    rank: 3,
    re: `${NUM_START}(\\d{1,3}(?:[.,]\\d{3})+|\\d+)${CURRENCY}`,
    fn: (m) => num(m[1]),
  },
  { // grouped thousands: 120.000, 120,000, 1.250.000
    rank: 2,
    re: `${NUM_START}(\\d{1,3}(?:[.,]\\d{3})+)(?![\\p{L}\\p{N}%]|[.,/-]\\d)`,
    fn: (m) => num(m[1]),
  },
  { // bare: 120000, 45, 1,5
    rank: 1,
    re: `${NUM_START}(\\d+(?:[.,]\\d{1,2})?)(?![\\p{L}\\p{N}%]|[.,/-]\\d)`,
    bare: true,
    fn: (m) => {
      const v = num(m[1], { grouped: false });
      return v < 1000 ? v * 1000 : v;
    },
  },
];

function parseAmount(sc) {
  const found = [];
  for (const rule of AMOUNT_RULES) {
    for (const m of sc.matches(rule.re)) {
      const end = m.index + m[0].length;
      if (found.some((f) => m.index < f.end && end > f.start)) continue;
      if (!accentOk(sc.orig(m.index, end))) continue;
      if (rule.bare && QUANTITY_AFTER.test(sc.masked.slice(end))) continue;
      const value = Math.round(rule.fn(m));
      if (!Number.isFinite(value) || value <= 0 || value > MAX_AMOUNT) continue;
      found.push({ start: m.index, end, rank: rule.rank, value });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.rank - a.rank || b.start - a.start);
  const best = found[0];
  sc.consume(best.start, best.end);
  return best.value;
}

// ---- dates -------------------------------------------------------------------------

const WD_WORD = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, hai: 1, ba: 2, tu: 3, nam: 4, sau: 5, bay: 6 };
const DATE_RULES = [
  {
    re: `${B}(?:hom\\s+nay|hnay|bua\\s+nay|(?:sang|trua|chieu|toi)\\s+nay|today)${E}`,
    fn: (m, t) => t,
  },
  {
    re: `${B}(?:hom\\s+qua|hqua|bua\\s+qua|(?:sang|trua|chieu|toi|dem)\\s+qua|yesterday)${E}`,
    fn: (m, t) => addDays(t, -1),
  },
  { re: `${B}(?:hom\\s+kia|hkia|bua\\s+kia)${E}`, fn: (m, t) => addDays(t, -2) },
  {
    re: `${B}(\\d{1,2})\\s+ngay\\s+truoc${E}`,
    fn: (m, t) => (+m[1] >= 1 && +m[1] <= 366 ? addDays(t, -+m[1]) : null),
  },
  {
    re: `${B}(?:thu\\s*(2|3|4|5|6|7|hai|ba|tu|nam|sau|bay)|t([2-7])|(chu\\s*nhat|cn))(?:\\s+(tuan\\s+truoc|tuan\\s+nay))?${E}`,
    fn(m, t) {
      const wd = m[1] ? WD_WORD[m[1]] : m[2] ? WD_WORD[m[2]] : 0;
      if ((m[4] || '').startsWith('tuan truoc')) return addDays(addDays(mondayOf(t), -7), (wd + 6) % 7);
      return addDays(t, -((weekday(t) - wd + 7) % 7));
    },
  },
  {
    re: `(?<![\\p{L}\\p{N}/])(?:ngay\\s+)?(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{4}|\\d{2}))?(?![\\p{L}\\p{N}/-])`,
    fn(m, t) {
      const d = +m[1], mo = +m[2];
      if (m[3]) {
        const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        return validYmd(y, mo, d) ? isoDay(y, mo, d) : null;
      }
      const y0 = +t.slice(0, 4);
      for (let y = y0; y >= y0 - 8; y--) {
        if (validYmd(y, mo, d) && isoDay(y, mo, d) <= t) return isoDay(y, mo, d);
      }
      return null;
    },
  },
];

function parseDate(sc, t) {
  for (const rule of DATE_RULES) {
    for (const m of sc.matches(rule.re)) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      const day = rule.fn(m, t);
      if (day) {
        sc.take(m);
        return day;
      }
    }
  }
  return null;
}

// ---- payment method ----------------------------------------------------------------

const PAYMENT = {
  e_wallet: ['momo', 'zalopay', 'zalo pay', 'vnpay', 'vn pay', 'shopeepay', 'shopee pay', 'airpay',
    'viettelpay', 'viettel pay', 'viettel money', 'vi dien tu', 'vi momo', 'vi', 'e wallet', 'ewallet', 'apple pay', 'google pay'],
  bank: ['chuyen khoan', 'ck', 'bank', 'banking', 'internet banking', 'ngan hang', 'stk', 'transfer'],
  credit_card: ['the tin dung', 'the visa', 'visa', 'mastercard', 'master card', 'master', 'credit card',
    'credit', 'jcb', 'amex', 'quet the', 'the'],
  cash: ['tien mat', 'tm', 'cash'],
};
const PAYMENT_LIST = Object.entries(PAYMENT)
  .flatMap(([method, words]) => words.map((w) => ({ method, w })))
  .sort((a, b) => b.w.length - a.w.length);
const PAYMENT_RE = `${B}(?:(?:tra|thanh\\s+toan|tt)\\s+)?(?:(?:bang|qua|by|via)\\s+)?(${PAYMENT_LIST
  .map((p) => p.w.replace(/ /g, '\\s+')).join('|')})${E}`;

function parsePayment(sc) {
  for (const m of sc.matches(PAYMENT_RE)) {
    if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
    const key = m[1].replace(/\s+/g, ' ');
    const hit = PAYMENT_LIST.find((p) => p.w === key);
    if (!hit) continue;
    // bare "the"/"vi" are English "the" / Vietnamese "vì" unless typed as "thẻ"/"ví"
    if (key === 'the' || key === 'vi') {
      const word = sc.orig(m.index + m[0].length - key.length, m.index + m[0].length).toLowerCase();
      if (word !== (key === 'the' ? 'thẻ' : 'ví')) continue;
    }
    sc.take(m);
    return hit.method;
  }
  return null;
}

// ---- public API ------------------------------------------------------------------

/**
 * @param {string} text
 * @param {{today?: string|Date}} [opts] today defaults to the user's current day.
 * @returns {{amount: number|null, description: string, spent_on: string, payment_method: string|null}}
 */
export function parseExpenseInput(text, { today } = {}) {
  const t = resolveToday(today);
  const sc = new Scanner(text);
  const spent_on = parseDate(sc, t) ?? t;
  const payment_method = parsePayment(sc);
  const amount = parseAmount(sc);
  return { amount, description: sc.remainder(), spent_on, payment_method };
}
