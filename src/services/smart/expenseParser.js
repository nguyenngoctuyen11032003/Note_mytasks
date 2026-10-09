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
// - Slang: "củ"/"cu" = triệu, "xị"/"trăm" = 100 000; "rưỡi" adds half a unit ("5 củ
//   rưỡi" = 5 500 000); a spaced tail after triệu/tỷ is a fraction ("1 tỷ 2"). A grouped
//   number before a unit is grouped ("1.250k" = 1 250 000, "1.500tr" = 1.5 tỷ).
// - A bare number < 1000 that is part of a name is not an amount: after a label word
//   ("phòng 302", "tháng 9", "lớp 5", "Win 11") or a camel-case product ("iPhone 15"),
//   or before a size/age unit ("55 inch", "512 gb", "20 tuổi"). Max 999 999 999 999.99.
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
import {
  Scanner, B, E, accentOk, isoDay, validYmd, mondayOf, resolveToday, normalizeVi, notADate, safeDay,
} from './text.js';

// numeric(14,2) column limit (same as services/expenses.js)
const MAX_AMOUNT = 999_999_999_999.99;

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
  // sizes / specs / ages: "55 inch", "512 gb", "20 tuổi"
  'inch', 'cm', 'mm', 'gb', 'tb', 'mb', 'ghz', 'mah', 'w', 'kw', 'hp', 'tuoi', 'size', 'met', 'cu',
];
const QUANTITY_AFTER = new RegExp(`^\\s*(?:${QUANTITY_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'u');
const QUANTITY_AHEAD = `(?!\\s*(?:${QUANTITY_WORDS.join('|')})(?![\\p{L}\\p{N}]))`;

// A bare number right after one of these words is part of a name, not a price:
// "phòng 302", "tháng 9", "lớp 5", "size 42", "Win 11", "Xiaomi 14".
const LABEL_BEFORE = new Set([
  'phong', 'thang', 'lop', 'tap', 'size', 'so', 'tang', 'ban', 'khu', 'quan', 'phuong', 'duong',
  'ngo', 'hem', 'kiet', 'toa', 'block', 'lo', 'nam', 'ky', 'quy', 'tuan', 'ngay', 'chuong', 'bai',
  'phan', 'kenh', 'model', 'version', 'ver', 'gen', 'series', 'iphone', 'ipad', 'galaxy', 'xiaomi',
  'redmi', 'oppo', 'vivo', 'samsung', 'pixel', 'nokia', 'macbook', 'win', 'windows', 'office',
  'ios', 'android', 'note', 'pro', 'max', 'plus', 'ultra', 'ps', 'xbox', 'level', 'lv', 'top',
]);
function isNameNumber(sc, index) {
  const prev = /([\p{L}\p{N}]+)\s*$/u.exec(sc.src.slice(0, index));
  if (!prev) return false;
  if (LABEL_BEFORE.has(normalizeVi(prev[1]))) return true;
  return /\p{Ll}\p{Lu}/u.test(prev[1]); // camel-case product names: "iPhone", "MacBook"
}

const NUM_START = '(?<![\\p{L}\\p{N}.,/-])';
const CURRENCY = '(?:\\s*(?:d|dong|vnd)(?![\\p{L}\\p{N}])|\\s*₫)';
// "củ" is slang for a million, but also a tuber ("2 củ hành", "củ cải").
const CU_NOT_TUBER = '(?!\\s+(?:hanh|toi|khoai|gung|sen|cai|nghe|san|kieu|dau|qua|ca\\s+rot)(?![\\p{L}\\p{N}]))';

/**
 * Number + unit (× mult) with an optional tail: attached digits ("1tr2", "1k5"),
 * "rưỡi" (+ half a unit) or — when `spaced` — a spaced digit group ("1 triệu 2",
 * "1 tỷ 2"; not when a quantity word follows: "2 triệu 2 người").
 * "1.250k" / "1,250k" / "1.500tr" are grouped thousands × unit.
 */
function unitRule(unit, mult, { spaced = false } = {}) {
  const spacedTail = spaced ? `\\s+(\\d{1,3})(?![\\p{L}\\p{N}])${QUANTITY_AHEAD}` : '(?!)()';
  return {
    rank: 3,
    re: `${NUM_START}(\\d+(?:[.,]\\d+)?)(?:${unit})(?:(\\d{1,3})(?!\\p{N})|\\s+(ruoi)(?![\\p{L}\\p{N}])|${spacedTail})?${CURRENCY}?${E}`,
    fn: (m) => (num(m[1]) + frac(m[2] ?? m[4]) + (m[3] ? 0.5 : 0)) * mult,
  };
}

const AMOUNT_RULES = [
  // millions: 1tr, 1tr2, 1tr250, 1,5tr, 2 triệu, 3m, 5 củ, 5tr rưỡi, 1 triệu 2
  unitRule(`\\s*(?:tr|trieu)|m|\\s*cu${CU_NOT_TUBER}`, 1e6, { spaced: true }),
  // billions: 2 tỷ, 1 tỷ 2
  unitRule('\\s*(?:ty|ti)', 1e9, { spaced: true }),
  // hundreds of thousands (slang): 2 xị, 2 trăm, 1 trăm rưỡi, 2 trăm nghìn
  unitRule('\\s*(?:xi|tram(?:\\s*(?:nghin|ngan|k)(?![\\p{L}\\p{N}]))?)', 1e5),
  // thousands: 35k, 35K, 35kđ, 1k5, 50 nghìn/ngàn, 1.250k
  unitRule('\\s*(?:k|nghin|ngan)', 1e3),
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

/**
 * @param {Scanner} sc
 * @param {{bareThousands?: boolean}} [opts] bareThousands=false (shopping): a bare number
 *   < 1000 is never a price ("Rau 15", "Xiaomi 14", "Bút bi 0.5").
 */
function parseAmount(sc, { bareThousands = true } = {}) {
  const found = [];
  for (const rule of AMOUNT_RULES) {
    for (const m of sc.matches(rule.re)) {
      const end = m.index + m[0].length;
      if (found.some((f) => m.index < f.end && end > f.start)) continue;
      if (!accentOk(sc.orig(m.index, end))) continue;
      if (rule.bare) {
        if (QUANTITY_AFTER.test(sc.masked.slice(end))) continue;
        const raw = num(m[1], { grouped: false });
        if (raw < 1000 && (!bareThousands || isNameNumber(sc, m.index))) continue;
      }
      const value = Math.round(rule.fn(m));
      // an out-of-range unit amount ("1000 tỷ") still blocks its digits from being re-read
      const ok = Number.isFinite(value) && value > 0 && value <= MAX_AMOUNT;
      found.push({ start: m.index, end, rank: rule.rank, value: ok ? value : null });
    }
  }
  const valid = found.filter((f) => f.value != null);
  if (!valid.length) return null;
  valid.sort((a, b) => b.rank - a.rank || b.start - a.start);
  const best = valid[0];
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
    re: `(?<![\\p{L}\\p{N}/.,])(ngay\\s+)?(\\d{1,2})([/-])(\\d{1,2})(?:[/-](\\d{4}|\\d{2}))?(?![\\p{L}\\p{N}/-]|[.,]\\d)`,
    fn(m, t, sc) {
      const d = +m[2], mo = +m[4];
      if (m[5]) {
        const y = m[5].length === 2 ? 2000 + +m[5] : +m[5];
        return validYmd(y, mo, d) ? isoDay(y, mo, d) : null;
      }
      // "1/2 kg", "cafe 30k 1/2" are fractions; "họp 1-1" is a one-on-one
      const after = sc.folded.slice(m.index + m[0].length);
      if (notADate({ d: m[2], m: m[4], sep: m[3], prefixed: !!m[1], after })) return null;
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
      const day = safeDay(() => rule.fn(m, t, sc));
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

// ---- category hashtag (quick-entry bar) ------------------------------------------

const TAG_SPLIT = /[\s]+/u;
const foldTag = (s) => normalizeVi(String(s).replace(/[_\-.]+/g, ' '));

/**
 * Find "#<category>" in the text. The hashtag may span several words
 * ("#ăn uống", "#an_uong", "#đi-lại"); the longest phrase equal to a category
 * name wins, else a single word that prefixes a category name ("#an" → Ăn uống).
 * An unknown tag is still removed and reported as `hint`.
 * @returns {{ text: string, category_id: string|null, hint: string|null }}
 */
export function extractCategoryTag(text, categories = []) {
  const src = String(text ?? '').normalize('NFC');
  const m = /(^|\s)#(\S*)/u.exec(src);
  if (!m) return { text: src, category_id: null, hint: null };
  const start = m.index + m[1].length;
  const after = src.slice(start + 1);
  const words = after.split(TAG_SPLIT);
  const cats = (categories || []).filter((c) => c && c.id != null && (!c.kind || c.kind === 'expense'))
    .map((c) => ({ id: c.id, key: foldTag(c.name) }));
  let used = 0;
  let id = null;
  for (let k = Math.min(4, words.length); k >= 1 && !id; k--) {
    const phrase = foldTag(words.slice(0, k).join(' '));
    if (!phrase) continue;
    const hit = cats.find((c) => c.key === phrase);
    if (hit) { id = hit.id; used = k; }
  }
  const first = foldTag(words[0] || '');
  if (!id && first) {
    const hit = cats.find((c) => c.key.startsWith(first)) || cats.find((c) => c.key.replace(/ /g, '').startsWith(first.replace(/ /g, '')));
    if (hit) id = hit.id;
    used = 1;
  }
  // length of "#" + the consumed words (with their separators) in the original text
  let len = 1;
  if (used) {
    const re = new RegExp(`^(?:\\S+)(?:\\s+\\S+){${used - 1}}`, 'u');
    len += (re.exec(after)?.[0].length) || 0;
  }
  const rest = (src.slice(0, start) + ' ' + src.slice(start + len)).replace(/\s+/g, ' ').trim();
  return { text: rest, category_id: id, hint: id ? null : (words[0] || null) };
}

/**
 * Quick-entry parse = parseExpenseInput + "#danh mục".
 * @returns {{amount, description, spent_on, payment_method, category_id: string|null, category_hint: string|null}}
 */
export function parseExpenseEntry(text, { today, categories = [] } = {}) {
  const tag = extractCategoryTag(text, categories);
  const base = parseExpenseInput(tag.text, { today });
  return { ...base, category_id: tag.category_id, category_hint: tag.hint };
}

// ---- shopping quick-add ---------------------------------------------------------------

const QTY_RE = `(?<![\\p{L}\\p{N}])(?:x\\s*(\\d{1,4})|(\\d{1,4})\\s*x|sl\\s*:?\\s*(\\d{1,4}))(?![\\p{L}\\p{N}])`;
const MUST_RE = `${B}(?:phai\\s+mua|can\\s+gap|gap)${E}`;

/**
 * "sữa tắm 120k x2 !" → { name: 'sữa tắm', unit_price: 120000, quantity: 2, priority: 'high' }
 * - quantity: "x2", "2x", "sl 2" (default 1)
 * - priority: "!!" / "gấp" / "phải mua" → must_buy, "!" → high (null when absent)
 * - price: same amount rules as expenses (k / tr / grouped / bare ≥ 1000), read as the
 *   UNIT price. A bare number < 1000 is part of the name ("Xiaomi 14", "Rau 15"). null
 *   when absent.
 */
export function parseShoppingInput(text) {
  let src = String(text ?? '').normalize('NFC');
  let priority = null;
  const bang = /(^|\s)(!{1,3})(?=\s|$)/u.exec(src);
  if (bang) {
    priority = bang[2].length >= 2 ? 'must_buy' : 'high';
    src = (src.slice(0, bang.index) + ' ' + src.slice(bang.index + bang[0].length)).trim();
  }
  const sc = new Scanner(src);
  for (const m of sc.matches(MUST_RE)) {
    if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
    sc.take(m);
    priority = 'must_buy';
    break;
  }
  let quantity = 1;
  for (const m of sc.matches(QTY_RE)) {
    const q = Number(m[1] || m[2] || m[3]);
    if (q >= 1 && q <= 9999) { quantity = q; sc.take(m); break; }
  }
  const unit_price = parseAmount(sc, { bareThousands: false });
  return { name: sc.remainder(), unit_price, quantity, priority };
}
