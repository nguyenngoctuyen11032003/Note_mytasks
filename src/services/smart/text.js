// Shared Vietnamese text helpers for the smart library (pure, no I/O).
//
// Key idea: `foldAligned` strips diacritics/case CHARACTER BY CHARACTER so the folded
// string has exactly the same length as the (NFC) source. Regexes run on the folded
// text (accent/case-insensitive) and their indices map 1:1 back to the original,
// which lets us cut recognised tokens out while keeping the user's casing/diacritics.

import { addDays, weekday, dayOf, today as todayDefault } from '../../utils/date.js';

const COMBINING =/[̀-ͯ]/g;

export function foldChar(ch) {
  if (ch === 'đ' || ch === 'Đ') return 'd';
  const s = ch.normalize('NFD').replace(COMBINING, '').toLowerCase();
  if (s.length === 1) return s;
  const l = ch.toLowerCase();
  return l.length === 1 ? l : ch;
}

/** Same-length accent/case fold of an NFC string. */
export function foldAligned(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) out += foldChar(text[i]);
  return out;
}

/** Zero-width space / non-joiner / joiner and BOM: invisible, never meaningful in input. */
const ZERO_WIDTH = /[​-‍﻿]/g;

/** String(text) → NFC without zero-width characters ('' for null/undefined). */
export function cleanText(text) {
  return String(text ?? '').normalize('NFC').replace(ZERO_WIDTH, '');
}

/** Lowercase, strip Vietnamese diacritics (đ→d), collapse whitespace, trim. */
export function normalizeVi(text) {
  return foldAligned(cleanText(text)).replace(/\s+/g, ' ').trim();
}

/** True when the text carries any Vietnamese diacritic (or đ), i.e. was typed "with accents". */
export function hasDiacritics(text) {
  const s = cleanText(text);
  for (const ch of s) {
    if (ch === 'đ' || ch === 'Đ') return true;
    if (/\p{L}/u.test(ch) && ch.normalize('NFD').length > 1) return true;
  }
  return false;
}

// Vietnamese tone marks (grave, acute, tilde, hook, dot below). Their position inside a
// syllable varies between "old" and "new" styles (hóa/hoá, khỏe/khoẻ), so accent-aware
// comparisons use the base letters + the set of tone marks, not the raw string.
const TONE_MARKS = /[̣̀́̃̉]/g;
/** Lowercased, tone-position-insensitive key of a word ("Hoá" and "hóa" → same key). */
export function toneKey(word) {
  const d = cleanText(word).toLowerCase().normalize('NFD');
  const tones = (d.match(TONE_MARKS) || []).sort().join('');
  return d.replace(TONE_MARKS, '').normalize('NFC') + (tones ? '|' + tones : '');
}

/** Regex fragments for unicode-aware word boundaries (JS \b is ASCII-only). */
export const B = '(?<![\\p{L}\\p{N}])';
export const E = '(?![\\p{L}\\p{N}])';

const ASCII = /^[\x00-\x7f]*$/;

// Folded words that collide with other common Vietnamese words once accents are
// stripped. A word in a match is accepted only when typed WITHOUT any diacritics
// (ASCII) or with one of the listed accented spellings. e.g. "mãi" ≠ "mai",
// "cười" ≠ "cuối", "vì" ≠ "ví", "tôi" ≠ "tối/tới".
const RISKY = {
  mai: ['mai'], mot: ['mốt'], nay: ['nay', 'này'], kia: ['kia'], qua: ['qua'],
  toi: ['tới', 'tối'], sau: ['sau', 'sáu'], tuan: ['tuần'], ngay: ['ngày'],
  thang: ['tháng'], cuoi: ['cuối'], thu: ['thứ'], hom: ['hôm'], chu: ['chủ'],
  nhat: ['nhật'], hai: ['hai'], ba: ['ba'], tu: ['tư', 'tử'], nam: ['năm'],
  bay: ['bảy', 'bẩy'], moi: ['mỗi'], hang: ['hằng', 'hàng'], thuong: ['thường'],
  cac: ['các'], dau: ['đầu'], nua: ['nữa'], truoc: ['trước'], sang: ['sáng'],
  chieu: ['chiều'], trua: ['trưa'], dem: ['đêm'], tien: ['tiền'], mat: ['mặt'],
  chuyen: ['chuyển'], khoan: ['khoản'], the: ['thẻ'], vi: ['ví'], dien: ['điện'],
  nghin: ['nghìn'], ngan: ['ngàn', 'ngân'], trieu: ['triệu'], phut: ['phút'],
  gio: ['giờ'], tieng: ['tiếng'], gap: ['gấp'], khan: ['khẩn'], cap: ['cấp'],
  thap: ['thấp'], binh: ['bình'], bang: ['bằng'], dong: ['đồng'], bua: ['bữa'],
  han: ['hạn'], vao: ['vào'], luc: ['lúc'],
  ty: ['tỷ', 'tỉ'], ti: ['tỉ', 'tỷ'], dung: ['dụng'], toan: ['toán'], tra: ['trả'],
  cu: ['củ'], xi: ['xị'], tram: ['trăm'], ruoi: ['rưỡi', 'rưởi'], mung: ['mùng', 'mồng'],
};
/** Words that must carry their accent (the bare ASCII form is too ambiguous). */
const ACCENT_REQUIRED = new Set(['ti']);

/** True when every word of the original span is an acceptable spelling. */
export function accentOk(original) {
  const words = original.normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of words) {
    const f = foldAligned(w);
    const allowed = RISKY[f];
    if (!allowed) continue;
    const lower = w.toLowerCase();
    if (ASCII.test(w)) {
      if (ACCENT_REQUIRED.has(f)) return false;
      continue;
    }
    if (!allowed.includes(lower)) return false;
  }
  return true;
}

/**
 * Span scanner: matches regexes against the folded text, consumes spans (masking
 * them with spaces so later patterns cannot reuse them) and rebuilds the leftover
 * original text.
 */
export class Scanner {
  constructor(text) {
    this.src = cleanText(text);
    this.folded = foldAligned(this.src);
    this.masked = this.folded;
    this.spans = [];
  }
  /** All matches of `source` (string, compiled with 'gu') on the masked text. */
  matches(source, flags = 'gu') {
    const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    return [...this.masked.matchAll(re)];
  }
  /** Same as matches() but on the original (unfolded) text, skipping consumed spans. */
  matchesOriginal(source, flags = 'gu') {
    const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    return [...this.src.matchAll(re)].filter((m) => !this.overlaps(m.index, m.index + m[0].length));
  }
  overlaps(start, end) {
    return this.spans.some(([s, e]) => start < e && end > s);
  }
  orig(start, end) {
    return this.src.slice(start, end);
  }
  consume(start, end) {
    if (end <= start) return;
    this.spans.push([start, end]);
    this.masked = this.masked.slice(0, start) + ' '.repeat(end - start) + this.masked.slice(end);
  }
  /** Match object → consume its whole span. */
  take(m) {
    this.consume(m.index, m.index + m[0].length);
  }
  /** Folded masked text before `index`, trimmed at the end (for look-behind heuristics). */
  before(index) {
    return this.masked.slice(0, index).replace(/\s+$/, '');
  }
  after(index) {
    return this.masked.slice(index).replace(/^\s+/, '');
  }
  /** Original text with consumed spans removed, whitespace and stray punctuation tidied. */
  remainder() {
    const sorted = [...this.spans].sort((a, b) => a[0] - b[0]);
    let out = '';
    let pos = 0;
    for (const [s, e] of sorted) {
      if (s < pos) { pos = Math.max(pos, e); continue; }
      out += this.src.slice(pos, s) + ' ';
      pos = e;
    }
    out += this.src.slice(pos);
    return tidy(out);
  }
}

export function tidy(s) {
  return s
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:!?.])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:\-–—|/+]+/, '')
    .replace(/[\s,;:\-–—|/+]+$/, '')
    .trim();
}

// ---- calendar helpers (pure, 'YYYY-MM-DD') ----------------------------------

export const pad2 = (n) => String(n).padStart(2, '0');
export const isoDay = (y, m, d) => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function validYmd(y, m, d) {
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) &&
    y >= 1900 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}
export const isIsoDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  validYmd(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));

// Units/counters that make a preceding "a/b" a fraction ("3/4 cuốn", "1/2 kg").
const FRACTION_UNIT_AFTER = /^\s*(?:kg|gr|gram|lit|ml|cuon|quyen|ly|coc|chuong|trang|cai|phan|bai|chai|lon|hop|goi|qua|trai|mieng|lat|bat|dia|suat|chiec|tep|quang|duong|km|thia|muong|banh|o|cu)(?![\p{L}\p{N}])/u;
const STANDALONE_FRACTIONS = new Set(['1/2', '1/4', '3/4']);

/**
 * Should a "d/m" or "d-m" match (no year) be rejected as a non-date? Documented rule:
 * - fraction: no "ngày/hạn/vào" prefix, d < m ≤ 12, and either a unit/counter word follows
 *   ("3/4 cuốn", "1/2 kg") or it is one of the stand-alone fractions 1/2, 1/4, 3/4
 *   (so "cafe 30k 1/2" is half, while "1/3" is still the 1st of March);
 * - hyphen form needs the prefix or a two-digit part ("5-11", "01-10"), so "họp 1-1" is
 *   a one-on-one, not the 1st of January.
 * @param {{d: string, m: string, sep: string, prefixed: boolean, after: string}} p
 *   d/m as typed, `after` = folded text right after the match.
 */
export function notADate({ d, m, sep, prefixed, after }) {
  if (prefixed) return false;
  if (sep === '-' && d.length < 2 && m.length < 2) return true;
  if (+d < +m && (FRACTION_UNIT_AFTER.test(after) || (sep === '/' && STANDALONE_FRACTIONS.has(`${+d}/${+m}`)))) return true;
  return false;
}

/** Run a date computation; any throw or out-of-range result (year > 9999…) → null. */
export function safeDay(fn) {
  try {
    const d = fn();
    return isIsoDay(d) ? d : null;
  } catch {
    return null;
  }
}

/** Monday (ISO week start) of the week containing `day`. */
export function mondayOf(day) {
  return addDays(day, -((weekday(day) + 6) % 7));
}

/** Resolve the `today` option: 'YYYY-MM-DD' | Date | undefined (→ user's today). */
export function resolveToday(t) {
  if (t instanceof Date) return dayOf(t);
  if (isIsoDay(t)) return t;
  if (t == null) return todayDefault();
  throw new TypeError(`Invalid today: ${t}`);
}
