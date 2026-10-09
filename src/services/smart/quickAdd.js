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
// - Title: original text minus recognised tokens, whitespace collapsed, casing/diacritics
//   kept. Never empty: falls back to the original text.

import { addDays, weekday, endOfMonth, startOfMonth, addMonths } from '../../utils/date.js';
import {
  Scanner, B, E, accentOk, normalizeVi, isoDay, validYmd, mondayOf, resolveToday, tidy,
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
    re: `(?<![\\p{L}\\p{N}/])(?:(?:vao|han|deadline)\\s+)?(?:ngay\\s+)?(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{4}|\\d{2}))?(?![\\p{L}\\p{N}/-])`,
    fn(m, today) {
      const d = +m[1], mo = +m[2];
      if (m[3]) {
        const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        return validYmd(y, mo, d) ? isoDay(y, mo, d) : null;
      }
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
    re: `${B}ngay\\s+(\\d{1,2})(?![\\p{L}\\p{N}/-])`,
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

function parseDate(sc, today) {
  for (const rule of DATE_RULES) {
    for (const m of sc.matches(rule.re)) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      const day = rule.fn(m, today, sc);
      if (day) {
        sc.take(m);
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
  { re: `${B}(?:(?:moi|hang)\\s+ngay|daily|every\\s*day)${E}`, value: 'daily' },
  { re: `${B}(?:(?:moi|hang)\\s+tuan|weekly|every\\s*week)${E}`, value: 'weekly' },
  { re: `${B}(?:(?:moi|hang)\\s+thang|monthly|every\\s*month)${E}`, value: 'monthly' },
];

function parseRecurrence(sc, today) {
  for (const rule of RECURRENCE_RULES) {
    for (const m of sc.matches(rule.re)) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      sc.take(m);
      const due = rule.weekdayGroup ? upcoming(today, wdIndex(m, rule.weekdayGroup), true) : null;
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
const PRIORITY_RE = `(?<![\\p{L}\\p{N}!])(!{1,3})(khan\\s+cap|khancap|trung\\s+binh|trungbinh|gap|khan|urgent|cao|high|tb|medium|med|vua|thap|low)?(?![\\p{L}\\p{N}!])`;

function parsePriority(sc) {
  let best = null;
  for (const m of sc.matches(PRIORITY_RE)) {
    let p = null;
    if (m[2]) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      p = PRIORITY_WORDS[m[2].replace(/\s+/g, ' ')];
    } else if (m[1].length >= 3) p = 'urgent';
    else if (m[1].length === 2) p = 'high';
    if (!p) continue;
    sc.take(m);
    if (!best || PRIORITY_RANK[p] > PRIORITY_RANK[best]) best = p;
  }
  return best;
}

// ---- duration ----------------------------------------------------------------------

const H_UNIT = '(?:h|g|hr|hrs|\\s*(?:gio|tieng))';
const M_UNIT = '(?:p|ph|m|min|mins|\\s*(?:phut|ph))';
const DURATION_RULES = [
  { re: `${B}(\\d{1,2})${H_UNIT}\\s*(\\d{1,2})${M_UNIT}?${E}`, hours: true, fn: (m) => (+m[2] < 60 ? +m[1] * 60 + +m[2] : null) },
  { re: `${B}(\\d{1,2}(?:[.,]\\d{1,2})?)${H_UNIT}${E}`, hours: true, fn: (m) => Math.round(parseFloat(m[1].replace(',', '.')) * 60) },
  { re: `${B}(\\d{1,4})${M_UNIT}${E}`, hours: false, fn: (m) => +m[1] },
];
const TIME_OF_DAY_BEFORE = /(?:^|\s)(?:luc|vao|tu|den|truoc|sau|at)$/;
const TIME_OF_DAY_AFTER = /^(?:sang|trua|chieu|toi|dem|am|pm)(?![\p{L}\p{N}])/u;

function parseDuration(sc) {
  for (const rule of DURATION_RULES) {
    for (const m of sc.matches(rule.re)) {
      if (!accentOk(sc.orig(m.index, m.index + m[0].length))) continue;
      if (rule.hours) {
        if (TIME_OF_DAY_BEFORE.test(sc.before(m.index))) continue;
        if (TIME_OF_DAY_AFTER.test(sc.after(m.index + m[0].length))) continue;
      }
      const minutes = rule.fn(m);
      if (!minutes || minutes < 1 || minutes > 24 * 60) continue;
      sc.take(m);
      return minutes;
    }
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

function parseCategory(sc, categories) {
  if (!Array.isArray(categories) || !categories.length) return null;
  const cats = categories
    .filter((c) => c && c.id != null && c.name)
    .map((c, order) => ({ id: c.id, kind: c.kind, n: normalizeVi(c.name), c: compact(normalizeVi(c.name)), order }));
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
  const category_id = parseCategory(sc, categories);
  const priority = parsePriority(sc);
  const { recurrence, due: recurDue } = parseRecurrence(sc, t);
  const estimated_minutes = parseDuration(sc);
  const due_date = recurDue ?? parseDate(sc, t);

  let title = sc.remainder();
  if (!title) title = tidy(sc.src) || sc.src.trim();
  return { title, due_date, priority, tags, estimated_minutes, category_id, recurrence };
}
