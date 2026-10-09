// Quick-add parser: one line of Vietnamese (with or without diacritics) → task fields.
//
//   parseTaskInput('Nộp báo cáo thứ 6 !gấp #work 1h30 @công', { today: '2026-10-09', categories })
//   → { title: 'Nộp báo cáo', due_date: '2026-10-16', priority: 'urgent', tags: ['work'],
//       estimated_minutes: 90, category_id: '…', recurrence: null }
//
// Rules (documented choices):
// - Absent fields are null ([] for tags) so the caller keeps its own defaults.
// - Weekdays ("thứ 2".."thứ 7", "t2".."t7", "cn", "chủ nhật"): the next occurrence
//   STRICTLY after today ("thứ 6" said on a Friday = next Friday). Add "này"/"tuần này"
//   to allow today ("thứ 6 này" on Friday = today). "thứ X tuần sau/tới" = that day in
//   next ISO week (Mon–Sun).
// - "tuần sau"/"tuần tới"/"đầu tuần sau" = next week's Monday. "cuối tuần" = the
//   coming Saturday (today when today is Sat/Sun). "cuối tuần sau" = next week's Sat.
//   "cuối tháng" = last day of this month; "cuối tháng sau"; "đầu tháng sau" = 1st.
// - "mai/ngày mai/sáng mai/tối mai…" = +1; "ngày kia/ngày mốt/mốt" = +2 (bare "mot"
//   without accent is NOT accepted: it is "một" = one). "hôm nay/hnay/tối nay…" = today.
//   "hôm qua" is ignored for tasks (left in the title). Capitalised "Mai" in the middle
//   of a sentence or after a kinship/preposition word ("chị Mai", "cho Mai") is a name.
// - "dd/mm", "dd-mm", "dd/mm/yy(yy)" (optionally prefixed by "ngày"/"hạn"/"vào"):
//   without a year → the first year ≥ this year where the date is valid and ≥ today
//   (so 29/02 jumps to the next leap year). Invalid dates (31/02) are ignored and left
//   in the title. "ngày 15" = next 15th (this month if not past). "3 ngày nữa"/"sau 3 ngày".
// - Only the first recognised date expression is used; later ones stay in the title.
// - Priority: !!! / !gấp / !khẩn (cấp) → urgent; !! / !cao → high; !tb / !trung bình → medium;
//   !thấp → low (English !urgent/!high/!medium/!low too). Several → the highest wins.
// - Duration: 30p, 30ph, 30 phút, 45m, 1h, 1g, 2 giờ, 1 tiếng, 1g30, 1h30m, 1.5h, 1,5h.
//   Single-letter units must be attached to the number. Hour values are skipped when
//   they look like a time of day ("lúc 9h", "9h sáng") or exceed 24h ("200g" = grams).
// - #tags: unicode letters/digits/_/-, lowercased, deduped, max 20; "#123" is not a tag.
// - @category: accent-insensitive prefix of a category name (multi-word: "@công việc",
//   "@congviec", "@cong"). Exact > task-kind > shorter name. Unknown @x stays in title.
// - Recurrence: mỗi/hằng/hàng ngày → daily; ngày thường / các ngày trong tuần / thứ 2-thứ 6
//   → weekdays; mỗi/hằng/hàng tuần → weekly; mỗi/hằng/hàng tháng → monthly;
//   "mỗi thứ 3" → weekly + due on the next Tuesday (today allowed).
// - Explicit estimate "~30p" / "~2h" / "~1g30" always wins over bare durations; a bare
//   hour right after a date word ("mai 9h", "thứ 6 14h", "12/10 9h") is a time of day.
// - Time of day ("lúc 9h", "9h30 sáng", "14:00", "mai 9h", "3h chiều") is reported as
//   due_time 'HH:MM' (key present only when found) and KEPT in the title — tasks have
//   no time column, so the title is where the hour stays visible.
// - "!1".."!4" = urgent..low (Todoist order). "ngày làm việc" → weekdays.
// - "#x" equal to a task category name (accent/space-insensitive) also sets category_id
//   when no "@category" was given; it stays a tag too.
// - Title: original text minus recognised tokens, whitespace collapsed, casing/diacritics
//   kept. Never empty: falls back to the original text.

import { addDays, weekday, endOfMonth, startOfMonth, addMonths } from '../../utils/date.js';
import {
  Scanner, B, E, accentOk, normalizeVi, isoDay, validYmd, mondayOf, resolveToday, safeDay, notADate,
} from './text.js';

const MAX_TAGS = 20;
const PRIORITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };

const WD_WORD = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, hai: 1, ba: 2, tu: 3, nam: 4, sau: 5, bay: 6 };
const WD = '(?:thu\\s*(2|3|4|5|6|7|hai|ba|tu|nam|sau|bay)|t([2-7])|(chu\\s*nhat|cn))';
function wdIndex(m, base = 1) {
  if (m[base]) return WD_WORD[m[base]];
  if (m[base + 1]) return WD_WORD[m[base + 1]];
  return 0; // Sunday
}
function upcoming(today, wd, allowToday) {
  const diff = (wd - weekday(today) + 7) % 7;
  return addDays(today, diff === 0 && !allowToday ? 7 : diff);
}
const nextMonday = (today) => addDays(mondayOf(today), 7);
const inNextWeek = (today, wd) => addDays(nextMonday(today), (wd + 6) % 7);

// Words that, right before "mai", mean "Mai" is a person (or a flower), not tomorrow.
const MAI_NAME_PREV = new Set([
  'chi', 'em', 'anh', 'co', 'ban', 'ong', 'ba', 'chu', 'bac', 'di', 'cau', 'mo', 'thim',
  'be', 'gap', 'goi', 'nhan', 'voi', 'cho', 'hen', 'gui', 'hoa', 'cay', 'nha', 'va', 'hoi',
  'bao', 'nho', 'tang', 'don', 'dua', 'thay',
]);

function isNameMai(sc, m, idx) {
  const prev = sc.before(idx).split(/\s+/).pop();
  if (MAI_NAME_PREV.has(prev)) return true;
  const ch = sc.src[idx];
  if (idx > 0 && ch === 'M' && sc.src !== sc.src.toUpperCase()) {
    const before = sc.src.slice(0, idx).trimEnd();
    if (before && !/[.!?:\n]$/.test(before)) return true;
  }
  return false;
}

// ---- date resolution --------------------------------------------------------------

/** Ordered date patterns; handler returns 'YYYY-MM-DD' or null to reject the match. */
const DATE_RULES = [
  {
    re: `${B}${WD}(?:\\s+(tuan\\s+(?:sau|toi)|tuan\\s+nay|nay|tuan\\s+truoc))?${E}`,
    fn(m, today) {
      const wd = wdIndex(m);
      const mod = (m[4] || '').replace(/\s+/g, ' ');
      if (mod === 'tuan truoc') return null; // past — meaningless for a new task
      if (mod === 'tuan sau' || mod === 'tuan toi') return inNextWeek(today, wd);
      return upcoming(today, wd, mod === 'nay' || mod === 'tuan nay');
    },
  },
  {
    re: `(?<![\\p{L}\\p{N}/.,])(?:((?:vao|han|deadline)\\s+)?(ngay\\s+)?)(\\d{1,2})([/-])(\\d{1,2})(?:[/-](\\d{4}|\\d{2}))?(?![\\p{L}\\p{N}/-]|[.,]\\d)`,
    fn(m, today, sc) {
      const d = +m[3], mo = +m[5];
      if (m[6]) {
        const y = m[6].length === 2 ? 2000 + +m[6] : +m[6];
        return validYmd(y, mo, d) ? isoDay(y, mo, d) : null;
      }
      const after = sc.folded.slice(m.index + m[0].length);
      if (notADate({ d: m[3], m: m[5], sep: m[4], prefixed: !!(m[1] || m[2]), after })) return null;
      const y0 = +today.slice(0, 4);
      for (let y = y0; y <= y0 + 8; y++) {
        if (validYmd(y, mo, d) && isoDay(y, mo, d) >= today) return isoDay(y, mo, d);
      }
      return null;
    },
  },
  {
    re: `${B}(?:(\\d{1,3})\\s+ngay\\s+nua|sau\\s+(\\d{1,3})\\s+ngay)${E}`,
    fn(m, today) {
      const n = +(m[1] ?? m[2]);
      return n >= 1 && n <= 366 ? addDays(today, n) : null;
    },
  },
  {
    re: `${B}(cuoi|dau)\\s+(tuan|thang)(?:\\s+(nay|sau|toi))?${E}`,
    fn(m, today) {
      const [, edge, unit, mod] = m;
      const next = mod === 'sau' || mod === 'toi';
      if (unit === 'tuan') {
        if (edge === 'dau') return next ? nextMonday(today) : null;
        if (next) return addDays(nextMonday(today), 5);
        const wd = weekday(today);
        return wd === 0 || wd === 6 ? today : upcoming(today, 6, true);
      }
      const base = next ? addMonths(startOfMonth(today), 1) : today;
      if (edge === 'dau') return next ? startOfMonth(base) : null;
      return endOfMonth(base);
    },
  },
  { re: `${B}(?:tuan\\s+(?:sau|toi)|next\\s+week)${E}`, fn: (m, today) => nextMonday(today) },
  { re: `${B}(?:ngay\\s+kia|ngay\\s+mot)${E}`, fn: (m, today) => addDays(today, 2) },
  {
    // bare "mốt" only with its accent (ASCII "mot" = "một")
    re: `${B}mot${E}`,
    fn: (m, today, sc) => (sc.orig(m.index, m.index + 3).toLowerCase() === 'mốt' ? addDays(today, 2) : null),
  },
  {
    re: `${B}(?:(ngay|sang|trua|chieu|toi|dem)\\s+mai|mai|tomorrow)${E}`,
    fn(m, today, sc) {
      if (!m[1] && m[0] === 'mai' && isNameMai(sc, m, m.index)) return null;
      return addDays(today, 1);
    },
  },
  {
    re: `${B}(?:hom\\s+nay|hnay|bua\\s+nay|(?:sang|trua|chieu|toi|dem)\\s+nay|today)${E}`,
    fn: (m, today) => today,
  },
  {
    // "ngày 15 tháng 11", "mùng 2 tháng 1 năm 2028", "ngày 2 tháng 1 2028"
    re: `${B}(?:ngay|mung|mong)\\s+(\\d{1,2})\\s+thang\\s+(\\d{1,2})(?:\\s+(?:nam\\s+)?(\\d{4}))?${E}`,
    fn(m, today) {
      const d = +m[1], mo = +m[2];
      if (m[3]) return validYmd(+m[3], mo, d) ? isoDay(+m[3], mo, d) : null;
      const y0 = +today.slice(0, 4);
      for (let y = y0; y <= y0 + 8; y++) {
        if (validYmd(y, mo, d) && isoDay(y, mo, d) >= today) return isoDay(y, mo, d);
      }
      return null;
    },
  },
  {
    // not the day part of an (invalid) "ngày 31 tháng 2"
    re: `${B}ngay\\s+(\\d{1,2})(?![\\p{L}\\p{N}/-]|\\s+thang\\s+\\d)`,
    fn(m, today) {
      const d = +m[1];
      for (let i = 0; i < 12; i++) {
        const base = addMonths(startOfMonth(today), i);
        const y = +base.slice(0, 4), mo = +base.slice(5, 7);
        if (validYmd(y, mo, d) && isoDay(y, mo, d) >= today) return isoDay(y, mo, d);
      }
      return null;
    },
  },
];

// "tối thứ 7", "chiều t3", "sáng 20/10": the part of day before a date belongs to it.
// Not after "ăn/bữa/buổi/ca…" ("ăn tối thứ 7" = dinner on Saturday).
const PART_BEFORE_DATE = /(?<![\p{L}\p{N}])(sang|trua|chieu|toi|dem)\s+$/u;
const PART_KEEP_PREV = new Set(['an', 'bua', 'buoi', 'ca', 'com', 'tiec']);

function absorbPartOfDay(sc, index) {
  const pm = PART_BEFORE_DATE.exec(sc.masked.slice(0, index));
  if (!pm || !accentOk(sc.orig(pm.index, pm.index + pm[1].length))) return;
  if (PART_KEEP_PREV.has(sc.before(pm.index).split(/\s+/).pop())) return;
  sc.consume(pm.index, pm.index + pm[1].length);
}

function parseDate(sc, today) {
  for (const rule of DATE_RULES) {
    for (const m of sc.matches(rule.re)) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      const day = safeDay(() => rule.fn(m, today, sc));
      if (day) {
        sc.take(m);
        absorbPartOfDay(sc, m.index);
        return day;
      }
    }
  }
  return null;
}

// ---- recurrence --------------------------------------------------------------------

const RECURRENCE_RULES = [
  { re: `${B}(?:moi|hang)\\s+${WD}${E}`, value: 'weekly', weekdayGroup: 1 },
  {
    re: `${B}(?:(?:vao\\s+)?(?:(?:moi|hang)\\s+)?(?:cac\\s+)?ngay\\s+thuong|cac\\s+ngay\\s+trong\\s+tuan|(?:tu\\s+)?thu\\s*2\\s*(?:-|den|toi)\\s*thu\\s*6|weekdays?)${E}`,
    value: 'weekdays',
  },
  { re: `${B}(?:(?:vao\\s+)?(?:(?:moi|hang|cac)\\s+)?ngay\\s+lam\\s+viec|workdays?)${E}`, value: 'weekdays' },
  { re: `${B}(?:(?:moi|hang)\\s+ngay|daily|every\\s*day)${E}`, value: 'daily' },
  { re: `${B}(?:(?:moi|hang)\\s+tuan|weekly|every\\s*week)${E}`, value: 'weekly' },
  { re: `${B}(?:(?:moi|hang)\\s+thang|monthly|every\\s*month)${E}`, value: 'monthly' },
];

// "hàng" is also a noun: "khách hàng ngày mai" = customer + tomorrow, not "daily".
const HANG_NOUN_PREV = new Set(['khach', 'cua', 'mat', 'don', 'ngan', 'giao', 'nhan', 'chu', 'kho', 'lo', 'chuyen', 'xep', 'nhap', 'xuat']);

function parseRecurrence(sc, today) {
  for (const rule of RECURRENCE_RULES) {
    for (const m of sc.matches(rule.re)) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      const end = m.index + m[0].length;
      if (/ngay$/.test(m[0]) && /^(?:mai|kia|mot|nay)(?![\p{L}\p{N}])/u.test(sc.after(end))) continue;
      if (/^hang\s/.test(m[0]) && HANG_NOUN_PREV.has(sc.before(m.index).split(/\s+/).pop())) continue;
      sc.take(m);
      const due = rule.weekdayGroup ? safeDay(() => upcoming(today, wdIndex(m, rule.weekdayGroup), true)) : null;
      return { recurrence: rule.value, due };
    }
  }
  return { recurrence: null, due: null };
}

// ---- priority ----------------------------------------------------------------------

const PRIORITY_WORDS = {
  gap: 'urgent', khan: 'urgent', 'khan cap': 'urgent', khancap: 'urgent', urgent: 'urgent',
  cao: 'high', high: 'high',
  tb: 'medium', 'trung binh': 'medium', trungbinh: 'medium', medium: 'medium', med: 'medium', vua: 'medium',
  thap: 'low', low: 'low',
};
const PRIORITY_DIGIT = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };
const PRIORITY_RE = `(?<![\\p{L}\\p{N}!])(!{1,3})([1-4]|khan\\s+cap|khancap|trung\\s+binh|trungbinh|gap|khan|urgent|cao|high|tb|medium|med|vua|thap|low)?(?![\\p{L}\\p{N}!])`;

function parsePriority(sc) {
  let best = null;
  for (const m of sc.matches(PRIORITY_RE)) {
    let p = null;
    if (m[2]) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      p = PRIORITY_DIGIT[m[2]] || PRIORITY_WORDS[m[2].replace(/\s+/g, ' ')];
    } else if (m[1].length >= 3) p = 'urgent';
    else if (m[1].length === 2) p = 'high';
    if (!p) continue;
    sc.take(m);
    if (!best || PRIORITY_RANK[p] > PRIORITY_RANK[best]) best = p;
  }
  return best;
}

// ---- hours: clock time vs duration -------------------------------------------------
//
// One token grammar for "N h|g|giờ|tiếng [MM [p|phút]] [rưỡi]" (+ optional leading "~"),
// classified by context:
// - DURATION: "~…" (explicit estimate), "N tiếng" (+ "rưỡi"), an explicit minute unit
//   ("1h30m", "1g30p", "1h 15p"), a decimal ("1.5h", "1,5h"), or N ≤ 4 without any time
//   context ("làm 2h", "code 3h"); also N ≥ 24 ("trực 24h"; > 24h is rejected).
// - CLOCK TIME (due_time, kept in the title): after "lúc/vào/từ/đến/trước/sau/at", next to
//   a part of day ("9h sáng", "chiều nay 3h") or a date ("mai 10h", "15h hôm nay",
//   "14h ngày 20/10", "mỗi ngày 8h"), or when 5 ≤ N ≤ 23 ("họp 15h", "gặp khách 10h30",
//   "9 giờ 30"). A bare "Ng" with N ≥ 5 and no context is ignored ("5g" may be grams).
// - "14:30", "9pm", "9:15 am" are always clock times.

const MIN_UNIT = '(?:phut|ph|p|mins|min|m)';
// minutes written after a space without a unit must not be a count ("9h 30 người")
const NOT_COUNT = '(?!\\s*(?:nguoi|cai|ly|lan|trang|bai|chuong|phan|mon|km|kg|ngay|tuan|thang|nam))';
const HOUR_TOKEN = `(~\\s*)?(?<![\\p{L}\\p{N}.,:])(\\d{1,2}(?:[.,]\\d{1,2})?)(?:(h|g|hr|hrs)|\\s*(gio|tieng))` +
  `(?:(\\d{1,2})(?!\\p{N})(?:\\s*(${MIN_UNIT}))?|\\s*(\\d{1,2})\\s*(${MIN_UNIT})|\\s+(\\d{2})${NOT_COUNT}(?![\\p{L}\\p{N}]|\\s*[/\\-.:,]\\s*\\d)|\\s+(ruoi))?${E}`;
const COLON_TIME = `(?<![\\p{L}\\p{N}.,:])(\\d{1,2}):(\\d{2})(?:\\s*(am|pm))?${E}`;
const AMPM_TIME = `${B}(\\d{1,2})\\s*(am|pm)${E}`;
const EXPLICIT_MINUTES = `~\\s*(\\d{1,4})\\s*${MIN_UNIT}?${E}`;
const MINUTES_ONLY = `${B}(\\d{1,4})(?:(p|ph|m|min|mins)|\\s*(phut|ph))${E}`;

const TIME_OF_DAY_BEFORE = /(?:^|\s)(?:luc|vao|tu|den|truoc|sau|at)$/;
// A date word right before the hour ("mai 9h", "thứ 6 14h", "12/10 9h", "mỗi ngày 8h").
const DATE_WORD_BEFORE = /(?:^|\s)(?:mai|nay|kia|mot|cn|nhat|hnay|thu\s*(?:[2-7]|hai|ba|tu|nam|sau|bay)|t[2-7]|(?:moi|hang)\s+(?:ngay|sang|trua|chieu|toi|dem)|ngay\s+\d{1,2}|thang\s+\d{1,2}|nam\s+\d{4}|tuan\s+(?:sau|toi|nay)|cuoi\s+tuan|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)$/;
const DATE_WORD_AFTER = /^(?:mai|nay|kia|mot|hnay|hom\s+nay|ngay\s+(?:mai|kia|mot|\d{1,2})|thu\s*(?:[2-7]|hai|ba|tu|nam|sau|bay)|t[2-7]|cn|chu\s*nhat|\d{1,2}[/-]\d{1,2}|tuan\s+(?:sau|toi|nay)|cuoi\s+tuan|(?:sang|trua|chieu|toi|dem)\s+(?:nay|mai))(?![\p{L}\p{N}])/u;
const PART_AFTER = /^(sang|trua|chieu|toi|dem)(?![\p{L}\p{N}])/u;
const PART_BEFORE = /(?:^|\s)(sang|trua|chieu|toi|dem)(?:\s+(?:nay|mai|qua))?$/;

/** Folded UNMASKED text around a span (date/recurrence words may already be consumed). */
const foldedBefore = (sc, i) => sc.folded.slice(0, i).replace(/\s+$/, '');
function foldedAfter(sc, end) {
  const raw = sc.folded.slice(end);
  const trimmed = raw.replace(/^\s+/, '');
  return { text: trimmed, start: end + raw.length - trimmed.length };
}
/** Context regex hit whose original spelling is acceptable ("mãi" ≠ "mai"). */
function ctxAfter(sc, end, re) {
  const { text, start } = foldedAfter(sc, end);
  const m = re.exec(text);
  return m && accentOk(sc.orig(start, start + m[0].length)) ? m : null;
}
function ctxBefore(sc, index, re) {
  const before = foldedBefore(sc, index);
  const m = re.exec(before);
  return m && accentOk(sc.orig(m.index, before.length)) ? m : null;
}

function applyPart(h, part) {
  if (part === 'chieu' || part === 'pm') return h < 12 ? h + 12 : h;
  if (part === 'toi') return h < 12 ? h + 12 : 0; // "12h tối" ≈ midnight
  if (part === 'dem') return h === 12 ? 0 : h >= 6 && h < 12 ? h + 12 : h; // "11h đêm" = 23h, "2h đêm" = 2h
  if (part === 'trua') return h < 6 ? h + 12 : h; // "1h trưa" = 13h
  if (part === 'sang' || part === 'am') return h === 12 ? 0 : h;
  return h;
}
const hhmm = (h, min) => `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

/** Part of day given right after the time, or right before it ("chiều nay 3h"). */
function partOfDay(sc, start, end) {
  const a = ctxAfter(sc, end, PART_AFTER);
  if (a) return a[1];
  const b = ctxBefore(sc, start, PART_BEFORE);
  return b ? b[1] : null;
}

/**
 * Classify one HOUR_TOKEN match.
 * @returns {{kind: 'clock', time: string} | {kind: 'duration', minutes: number} | null}
 */
function classifyHour(sc, m) {
  const start = m.index + (m[1] ? m[1].length : 0);
  const end = m.index + m[0].length;
  if (!accentOk(sc.orig(start, end))) return null;
  const [, tilde, num, hUnit, wUnit, mm1, mu1, mm2, mu2, mm3, half] = m;
  const unit = hUnit || wUnit;
  const minStr = mm1 ?? mm2 ?? mm3;
  const min = minStr != null ? +minStr : half ? 30 : 0;
  if (min > 59) return null;
  const decimal = /[.,]/.test(num);
  const n = decimal ? parseFloat(num.replace(',', '.')) : +num;
  const duration = () => {
    const minutes = decimal ? Math.round(n * 60) : n * 60 + min;
    return minutes >= 1 && minutes <= 24 * 60 ? { kind: 'duration', minutes } : null;
  };
  if (tilde || decimal || unit === 'tieng' || mu1 || mu2) return duration();

  const clock = () => {
    if (n > 23) return null;
    return { kind: 'clock', time: hhmm(applyPart(n, partOfDay(sc, start, end)), min) };
  };
  const cue = TIME_OF_DAY_BEFORE.test(foldedBefore(sc, start)) ||
    ctxAfter(sc, end, PART_AFTER) || ctxBefore(sc, start, PART_BEFORE) ||
    ctxBefore(sc, start, DATE_WORD_BEFORE) || ctxAfter(sc, end, DATE_WORD_AFTER);
  if (cue) return clock();
  if (n >= 24) return duration();
  if (n >= 5) return unit === 'g' && minStr == null ? null : clock();
  return duration();
}

/** Earliest clock time in the text, 'HH:MM' or null. Reported only — never consumed. */
function parseTimeOfDay(sc) {
  const found = [];
  for (const m of sc.matches(HOUR_TOKEN)) {
    if (m[1]) continue;
    const c = classifyHour(sc, m);
    if (c && c.kind === 'clock') { found.push({ i: m.index, time: c.time }); break; }
  }
  for (const m of sc.matches(COLON_TIME)) {
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) continue;
    const part = m[3] || partOfDay(sc, m.index, m.index + m[0].length);
    found.push({ i: m.index, time: hhmm(applyPart(h, part), min) });
    break;
  }
  for (const m of sc.matches(AMPM_TIME)) {
    const h = +m[1];
    if (h < 1 || h > 12) continue;
    found.push({ i: m.index, time: hhmm(applyPart(h, m[2]), 0) });
    break;
  }
  found.sort((a, b) => a.i - b.i);
  return found.length ? found[0].time : null;
}

function parseDuration(sc) {
  // 1. explicit estimate "~2h", "~1g30", "~30p", "~45" always wins
  for (const m of sc.matches(HOUR_TOKEN)) {
    if (!m[1]) continue;
    const c = classifyHour(sc, m);
    if (c && c.kind === 'duration') { sc.take(m); return c.minutes; }
  }
  for (const m of sc.matches(EXPLICIT_MINUTES)) {
    const minutes = +m[1];
    if (minutes >= 1 && minutes <= 24 * 60) { sc.take(m); return minutes; }
  }
  // 2. bare hours that read as a duration, then minutes ("30p", "45 phút")
  for (const m of sc.matches(HOUR_TOKEN)) {
    if (m[1]) continue;
    const c = classifyHour(sc, m);
    if (c && c.kind === 'duration') { sc.take(m); return c.minutes; }
  }
  for (const m of sc.matches(MINUTES_ONLY)) {
    if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
    const minutes = +m[1];
    if (minutes >= 1 && minutes <= 24 * 60) { sc.take(m); return minutes; }
  }
  return null;
}

// ---- tags & category ---------------------------------------------------------------

function parseTags(sc) {
  const tags = [];
  for (const m of sc.matchesOriginal('(?<![\\p{L}\\p{N}_&#/])#([\\p{L}\\p{N}_\\-]+)', 'gu')) {
    const tag = m[1].replace(/[-_]+$/, '').toLowerCase().slice(0, 50);
    if (!/\p{L}/u.test(tag)) continue; // "#123" = issue number, keep in title
    sc.take(m);
    if (!tags.includes(tag) && tags.length < MAX_TAGS) tags.push(tag);
  }
  return tags;
}

const compact = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '');

function matchCategory(query, cats) {
  const q = normalizeVi(query);
  const qc = compact(q);
  if (!qc) return null;
  let best = null;
  for (const c of cats) {
    let rank = 0;
    if (c.n === q || c.c === qc) rank = 3;
    else if (c.n.startsWith(q) || c.c.startsWith(qc)) rank = 2;
    if (!rank) continue;
    const key = [rank, c.kind === 'task' ? 1 : 0, -c.c.length, -c.order];
    if (!best || cmp(key, best.key) > 0) best = { key, cat: c };
  }
  return best && best.cat;
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

function prepCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .filter((c) => c && c.id != null && c.name)
    .map((c, order) => ({ id: c.id, kind: c.kind, n: normalizeVi(c.name), c: compact(normalizeVi(c.name)), order }));
}

/** "#sales" → the task category literally named "Sales" (accent/space-insensitive). */
function categoryFromTags(tags, categories) {
  const cats = prepCategories(categories).filter((c) => !c.kind || c.kind === 'task');
  for (const t of tags) {
    const key = compact(normalizeVi(t));
    const hit = key && cats.find((c) => c.c === key);
    if (hit) return hit.id;
  }
  return null;
}

function parseCategory(sc, categories) {
  if (!Array.isArray(categories) || !categories.length) return null;
  const cats = prepCategories(categories);
  for (const m of sc.matchesOriginal('(?<![\\p{L}\\p{N}_.])@([\\p{L}\\p{N}_\\-]+)', 'gu')) {
    let hit = matchCategory(m[1], cats);
    if (!hit) continue;
    let end = m.index + m[0].length;
    // greedily extend with following words while they still prefix-match a name
    let query = m[1];
    for (let i = 0; i < 3; i++) {
      const rest = sc.src.slice(end);
      const w = rest.match(/^\s+([\p{L}\p{N}_-]+)/u);
      if (!w) break;
      const longer = matchCategory(`${query} ${w[1]}`, cats);
      if (!longer || !cats.some((c) => c.n.startsWith(normalizeVi(`${query} ${w[1]}`)))) break;
      query = `${query} ${w[1]}`;
      hit = longer;
      end += w[0].length;
    }
    sc.consume(m.index, end);
    return hit.id;
  }
  return null;
}

// ---- public API ------------------------------------------------------------------

/**
 * @param {string} text
 * @param {{today?: string|Date, categories?: Array<{id, name, kind?}>}} [opts]
 *   today defaults to the user's current day (utils/date.js `today()`).
 */
export function parseTaskInput(text, { today, categories } = {}) {
  const t = resolveToday(today);
  const sc = new Scanner(text);

  const tags = parseTags(sc);
  const category_id = parseCategory(sc, categories) ?? categoryFromTags(tags, categories);
  const priority = parsePriority(sc);
  const { recurrence, due: recurDue } = parseRecurrence(sc, t);
  const estimated_minutes = parseDuration(sc);
  const due_date = recurDue ?? parseDate(sc, t);
  const due_time = parseTimeOfDay(sc);

  // Only metadata (tags / date / priority …) and no words left → empty title, so the
  // caller can ask for a title instead of creating a task named "#tag !cao".
  const title = sc.remainder();
  const out = { title, due_date, priority, tags, estimated_minutes, category_id, recurrence };
  if (due_time) out.due_time = due_time;
  return out;
}
