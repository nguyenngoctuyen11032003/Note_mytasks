// Rich editor Markdown model (stream A1): canonical Markdown <-> editor DOM.
//
//   mdToHtml(md, { editable })  Markdown → safe HTML string of the editor DOM
//   htmlToMd(root)              editor DOM (Element / DocumentFragment / HTML string) → canonical Markdown
//   normalizeMd(md)             canonical form of md (= htmlToMd(parse(mdToHtml(md))))
//
// Both directions go through one small AST. Inline content is a FLAT list of
// runs ({k:'t'|'c', text, m:[marks], a:href|null} | {k:'br'}), which makes the
// canonicalisation rules (marks never start/end with a space, adjacent identical
// marks merge, no empty marks, whitespace collapses) simple and identical for
// both directions. The serializer verifies every inline container by parsing
// its own output back and escalates escaping until the round trip is exact, and
// the whole document is serialized to a fixed point, so md → DOM → md is
// idempotent by construction.
//
// Safety: every text node / attribute goes through esc(); only tags built here
// are emitted; links are http(s)/mailto only; media src is nm-media:<path> or
// https:// only; no event handlers or style attributes are ever produced.
import { esc } from '../../utils/dom.js';

/* =====================================================================
   Shared helpers
   ===================================================================== */

const MARKS = ['b', 'i', 's', 'u', 'h']; // canonical order (tie-break for nesting)
const MARK_TAG = { b: 'strong', i: 'em', u: 'u', s: 's', h: 'mark' };
const MARK_MD = { b: '**', u: '++', s: '~~', h: '==' }; // italic is '_' or '*' (resolved per use)

export const AUDIO_EXT_RE = /\.(webm|ogg|m4a|mp4|mp3|wav)$/i;
const MEDIA_RE = /^nm-media:[A-Za-z0-9_\-./]+$/;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const ZW_RE = /[​﻿⁠]/g;
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const PH_PIPE = '\u0001'; // escaped table pipe while parsing a cell

const isWs = (c) => !c || /\s/.test(c);
const isAlnum = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
const isPunct = (c) => !!c && c.length === 1 && ASCII_PUNCT_RE.test(c);

// '|' is encoded too (and PH_PIPE, an escaped `\|` inside a table cell, becomes '%7C'):
// a raw pipe in a link destination would be escaped as a cell separator and break the link.
const encUrl = (s) => s.split(PH_PIPE).join('|').replace(/[ ()<>"|]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

/** Normalised safe link target (http(s)/mailto) or null. */
export function safeHref(u) {
  const s = encUrl(String(u ?? '').trim());
  if (!s || CTRL_RE.test(s) || /\s/.test(s)) return null;
  if (/^https?:\/\/[^/?#\\]/i.test(s) || /^mailto:[^/]/i.test(s)) return s;
  return null;
}

/** Normalised safe media source (nm-media:<path> or https://) or null. */
export function safeMediaSrc(u) {
  const s = String(u ?? '').trim();
  if (MEDIA_RE.test(s) && !s.includes('..')) return s;
  const h = encUrl(s);
  if (!CTRL_RE.test(h) && /^https:\/\/[^/?#\\\s]+[^\s]*$/i.test(h)) return h;
  return null;
}

const normW = (v) => {
  const n = Math.round(Number(String(v ?? '').replace('%', '')));
  if (!Number.isFinite(n) || n <= 0 || v === '' || v == null) return null;
  const w = Math.min(100, Math.max(10, n));
  return w === 100 ? null : w;
};

const unescapeText = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const cleanText = (s) => String(s ?? '').replace(ZW_RE, '').replace(/\s+/g, ' ').trim();
const escPlain = (s) => s.replace(/[\\[\]]/g, (c) => '\\' + c);

const IMG_LINE_RE = /^!\[((?:\\[\s\S]|[^\\\]])*)\]\([ \t]*(\S+?)(?:[ \t]+"([^"]*)")?[ \t]*\)$/;
const AUDIO_LINE_RE = /^\[((?:\\[\s\S]|[^\\\]])*)\]\([ \t]*(nm-media:[^\s)]+)[ \t]*\)$/;

/** A line that is only an image → { src, alt, w } (else null). */
export function imageLine(line) {
  const m = IMG_LINE_RE.exec(String(line ?? '').trim());
  if (!m) return null;
  const src = safeMediaSrc(m[2]);
  if (!src) return null;
  const w = /^w=(\d{1,3})$/.exec(m[3] || '');
  return { src, alt: cleanText(unescapeText(m[1])), w: w ? normW(w[1]) : null };
}

/** A line that is only an audio link → { src, label } (else null). */
export function audioLine(line) {
  const m = AUDIO_LINE_RE.exec(String(line ?? '').trim());
  if (!m) return null;
  const src = safeMediaSrc(m[2]);
  if (!src || !src.startsWith('nm-media:') || !AUDIO_EXT_RE.test(src)) return null;
  return { src, label: cleanText(unescapeText(m[1])) };
}

/* =====================================================================
   Inline runs: normalisation
   ===================================================================== */

const sortMarks = (m) => MARKS.filter((x) => m.includes(x));
const sameMarks = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function normRuns(input) {
  const a = [];
  for (const r of input) {
    if (r.k === 'br' || r.k === 'bb') { a.push({ k: 'br' }); continue; }
    if (r.k !== 't' && r.k !== 'c') continue;
    const text = r.k === 't'
      ? r.text.replace(ZW_RE, '').replace(/\s+/g, ' ')
      : r.text.replace(ZW_RE, '').replace(/[\n\r\t ]/g, ' ');
    if (text) a.push({ k: r.k, text, m: sortMarks(r.m || []), a: r.a || null });
  }
  // split text runs into words / single spaces
  const p = [];
  for (const r of a) {
    if (r.k !== 't') { p.push(r); continue; }
    for (const piece of r.text.split(/( )/)) if (piece) p.push(piece === ' ' ? { k: 'ws', m: r.m, a: r.a } : { ...r, text: piece });
  }
  // spaces: trimmed at line edges, collapsed, and only keep marks shared with both neighbours
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const x = p[i];
    if (x.k !== 'ws') { out.push(x); continue; }
    if (i > 0 && p[i - 1].k === 'ws') continue;
    let k = i;
    let m = x.m;
    let href = x.a;
    while (k < p.length && p[k].k === 'ws') {
      m = m.filter((y) => p[k].m.includes(y));
      if (p[k].a !== href) href = null;
      k++;
    }
    const L = p[i - 1];
    const R = p[k];
    if (!L || !R || L.k === 'br' || R.k === 'br') continue;
    m = m.filter((y) => L.m.includes(y) && R.m.includes(y));
    out.push({ k: 't', text: ' ', m, a: href && L.a === href && R.a === href ? href : null });
  }
  // merge
  const res = [];
  for (const x of out) {
    const last = res[res.length - 1];
    if (x.k === 'br') { if (last && last.k !== 'br') res.push({ k: 'br' }); continue; }
    if (last && last.k === x.k && last.a === x.a && sameMarks(last.m, x.m)) last.text += x.text;
    else res.push({ ...x });
  }
  while (res.length && res[res.length - 1].k === 'br') res.pop();
  return res;
}

const brToSpace = (runs) => normRuns(runs.map((r) => (r.k === 'br' || r.k === 'bb' ? { k: 't', text: ' ', m: [], a: null } : r)));
const runsKey = (runs) => JSON.stringify(runs.map((r) => (r.k === 'br' ? 0 : [r.k, r.text, r.m.join(''), r.a || ''])));

/* =====================================================================
   Inline Markdown → runs
   ===================================================================== */

const runLen = (s, i, ch) => { let j = i; while (s[j] === ch) j++; return j - i; };

function findCodeEnd(s, from, len) {
  let j = from;
  while (j < s.length) {
    if (s[j] === '`') {
      const r = runLen(s, j, '`');
      if (r === len) return j;
      j += r;
    } else j++;
  }
  return -1;
}

function codeContent(s) {
  let t = s.replace(/\n/g, ' ');
  if (t.length >= 2 && t[0] === ' ' && t[t.length - 1] === ' ' && /[^ ]/.test(t)) t = t.slice(1, -1);
  return t;
}

const LINK_DEST_RE = /\([ \t]*(?:<([^<>\n]*)>|([^\s()<>]+))(?:[ \t]+"[^"\n]*")?[ \t]*\)/y;

function parseLinkAt(s, i) {
  let depth = 0;
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && isPunct(s[j + 1])) { j += 2; continue; }
    if (ch === '`') {
      const r = runLen(s, j, '`');
      const e = findCodeEnd(s, j + r, r);
      j = e >= 0 ? e + r : j + r;
      continue;
    }
    if (ch === '\n') return null;
    if (ch === '[') depth++;
    else if (ch === ']') { if (depth === 0) break; depth--; }
    j++;
  }
  if (s[j] !== ']') return null;
  LINK_DEST_RE.lastIndex = j + 1;
  const m = LINK_DEST_RE.exec(s);
  if (!m) return null;
  const href = safeHref(m[1] ?? m[2]);
  if (!href) return null;
  return { text: s.slice(i + 1, j), href, end: LINK_DEST_RE.lastIndex };
}

function tokenize(s, inLink) {
  const toks = [];
  let buf = '';
  const flush = () => { if (buf) { toks.push({ k: 't', text: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && isPunct(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '\n') { flush(); toks.push({ k: 'br' }); i++; continue; }
    if (c === '`') {
      const r = runLen(s, i, '`');
      const e = findCodeEnd(s, i + r, r);
      if (e >= 0) { flush(); toks.push({ k: 'c', text: codeContent(s.slice(i + r, e)) }); i = e + r; continue; }
      buf += s.slice(i, i + r);
      i += r;
      continue;
    }
    if (c === '[' && !inLink) {
      const l = parseLinkAt(s, i);
      if (l) { flush(); toks.push({ k: 'a', href: l.href, runs: buildRuns(tokenize(l.text, true)) }); i = l.end; continue; }
      buf += c;
      i++;
      continue;
    }
    if ('*_~=+'.includes(c)) {
      const r = runLen(s, i, c);
      const prev = s[i - 1];
      const next = s[i + r];
      const valid = '~=+'.includes(c) ? r === 2 : r <= 3;
      let canOpen = false;
      let canClose = false;
      if (valid) {
        if (c === '_') {
          canOpen = !isWs(next) && !isAlnum(prev);
          canClose = !isWs(prev) && !isAlnum(next);
        } else {
          canOpen = !isWs(next);
          canClose = !isWs(prev);
        }
      }
      if (canOpen || canClose) {
        flush();
        toks.push({ k: 'd', ch: c, len: r, rem: r, canOpen, canClose, opens: [], closes: [] });
      } else buf += s.slice(i, i + r);
      i += r;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return toks;
}

// CommonMark "rule of 3": a both-flanking delimiter cannot pair when the run lengths sum to a multiple of 3.
const ruleOf3 = (o, d) => (o.canClose || d.canOpen) && (o.len + d.len) % 3 === 0 && !(o.len % 3 === 0 && d.len % 3 === 0);

function buildRuns(toks) {
  const stack = [];
  for (const d of toks) {
    if (d.k !== 'd') continue;
    if (d.canClose) {
      while (d.rem > 0) {
        let k = stack.length - 1;
        while (k >= 0 && !(stack[k].ch === d.ch && stack[k].rem > 0 && !ruleOf3(stack[k], d))) k--;
        if (k < 0) break;
        const o = stack[k];
        const use = '~=+'.includes(d.ch) ? 2 : o.rem >= 2 && d.rem >= 2 ? 2 : 1;
        const mark = d.ch === '~' ? 's' : d.ch === '=' ? 'h' : d.ch === '+' ? 'u' : use === 2 ? 'b' : 'i';
        o.rem -= use;
        d.rem -= use;
        o.opens.push(mark);
        d.closes.push(mark);
        stack.length = o.rem > 0 ? k + 1 : k;
      }
    }
    if (d.rem > 0 && d.canOpen) stack.push(d);
  }
  const act = { b: 0, i: 0, u: 0, s: 0, h: 0 };
  const cur = () => MARKS.filter((m) => act[m] > 0);
  const runs = [];
  for (const t of toks) {
    if (t.k === 't' || t.k === 'c') runs.push({ k: t.k, text: t.text, m: cur(), a: null });
    else if (t.k === 'br') runs.push({ k: 'br' });
    else if (t.k === 'a') {
      const outer = cur();
      for (const r of t.runs) runs.push(r.k === 'br' ? r : { ...r, m: sortMarks([...new Set([...r.m, ...outer])]), a: t.href });
    } else if (t.k === 'd') {
      for (const m of t.closes) act[m]--;
      if (t.rem) runs.push({ k: 't', text: t.ch.repeat(t.rem), m: cur(), a: null });
      for (const m of t.opens) act[m]++;
    }
  }
  return runs;
}

/** Inline Markdown (may contain \n = line break) → normalised runs. */
export function parseInline(src) {
  return normRuns(buildRuns(tokenize(String(src ?? ''), false)));
}

/* =====================================================================
   Runs → nested structure (shared by the Markdown and HTML writers)
   ===================================================================== */

const ORDER = (x) => (x.startsWith('a|') ? 0 : 1 + MARKS.indexOf(x));
const wantOf = (r) => (r.k === 'br' ? [] : r.a ? ['a|' + r.a, ...r.m] : r.m);

function nest(runs, { open, close, leaf }) {
  const stack = [];
  const extent = (i, x) => {
    let n = 0;
    for (let j = i; j < runs.length && runs[j].k !== 'br' && wantOf(runs[j]).includes(x); j++) n++;
    return n;
  };
  runs.forEach((r, i) => {
    const w = wantOf(r);
    const cut = stack.findIndex((x) => !w.includes(x));
    if (cut >= 0) while (stack.length > cut) close(stack.pop());
    // a space never opens a delimiter ("** x" cannot open): it keeps only marks already open
    if (r.k !== 'br' && !(r.k === 't' && !r.text.trim())) {
      w.filter((x) => !stack.includes(x))
        .sort((x, y) => extent(i, y) - extent(i, x) || ORDER(x) - ORDER(y))
        .forEach((x) => { open(x); stack.push(x); });
    }
    leaf(r, stack);
  });
  while (stack.length) close(stack.pop());
}

/** The runs as nest() can actually express them (spaces lose marks they would have to reopen). */
function effectiveRuns(input) {
  const runs = [];
  for (const r of input) {
    if (r.k !== 't') runs.push(r);
    else for (const piece of r.text.split(/( )/)) if (piece) runs.push({ ...r, text: piece });
  }
  const out = [];
  nest(runs, {
    open() {},
    close() {},
    leaf(r, stack) {
      if (r.k === 'br') { out.push(r); return; }
      const a = stack.find((x) => x.startsWith('a|'));
      out.push({ ...r, m: sortMarks(stack.filter((x) => !x.startsWith('a|'))), a: a ? a.slice(2) : null });
    },
  });
  return normRuns(out);
}

/* =====================================================================
   Runs → inline Markdown (verified, escalating escapes)
   ===================================================================== */

function codeSpan(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((x) => x.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.length >= 2 && text[0] === ' ' && text[text.length - 1] === ' ' && /[^ ]/.test(text)) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

function emitInline(runs, level, itMode = 'auto') {
  const parts = []; // { s, lit } | { it: 'o'|'c', id }
  const its = [];
  let ids = 0;
  nest(runs, {
    open(x) {
      if (x === 'i') { its.push(ids); parts.push({ it: 'o', id: ids++ }); } else parts.push({ s: x.startsWith('a|') ? '[' : MARK_MD[x] });
    },
    close(x) {
      if (x === 'i') parts.push({ it: 'c', id: its.pop() });
      else parts.push({ s: x.startsWith('a|') ? '](' + x.slice(2) + ')' : MARK_MD[x] });
    },
    leaf(r) {
      if (r.k === 'br') parts.push({ s: '\n' });
      else if (r.k === 't') parts.push({ s: r.text, lit: true });
      else parts.push({ s: codeSpan(r.text) });
    },
  });
  // italic: '_' unless a letter/digit touches the outside of the pair → '*'
  const pos = new Array(parts.length);
  const closeAt = {};
  let n = 0;
  parts.forEach((p, k) => { pos[k] = n; n += p.it ? 1 : p.s.length; if (p.it === 'c') closeAt[p.id] = k; });
  const strs = parts.map((p) => (p.it ? '\u0002' : p.s));
  const joined = strs.join('');
  const choice = {};
  parts.forEach((p, k) => {
    if (p.it !== 'o') return;
    const before = joined[pos[k] - 1];
    const after = joined[pos[closeAt[p.id]] + 1];
    choice[p.id] = itMode !== 'auto' ? itMode : isAlnum(before) || isAlnum(after) ? '*' : '_';
  });
  parts.forEach((p, k) => { if (p.it) strs[k] = choice[p.id]; });
  const S = strs.join('');
  if (level === 0) return S;
  const lit = new Uint8Array(S.length);
  parts.forEach((p, k) => { if (p.lit) lit.fill(1, pos[k], pos[k] + p.s.length); });
  const escd = new Array(S.length).fill(false);
  for (let q = S.length - 1; q >= 0; q--) {
    if (!lit[q]) continue;
    const c = S[q];
    if (level >= 2) { if ('\\*_~=+`[]'.includes(c)) escd[q] = true; continue; }
    if (c === '\\') {
      const nx = escd[q + 1] ? '\\' : S[q + 1];
      if (isPunct(nx)) escd[q] = true;
    } else if (c === '`' || c === '[' || c === ']') escd[q] = true;
    else if ('*_~=+'.includes(c)) {
      let a = q;
      let b = q;
      while (S[a - 1] === c) a--;
      while (S[b + 1] === c) b++;
      let mixed = false;
      for (let z = a; z <= b; z++) if (!lit[z]) mixed = true;
      const len = b - a + 1;
      const prev = S[a - 1];
      const next = S[b + 1];
      const valid = '~=+'.includes(c) ? len === 2 : len <= 3;
      const flank = c === '_'
        ? (!isWs(next) && !isAlnum(prev)) || (!isWs(prev) && !isAlnum(next))
        : !isWs(next) || !isWs(prev);
      if (mixed || (valid && flank) || ('~=+'.includes(c) && len > 2)) escd[q] = true;
    }
  }
  const out = [];
  for (let q = 0; q < S.length; q++) out.push(escd[q] ? '\\' + S[q] : S[q]);
  return out.join('');
}

/** Runs → Markdown; `post` (line-level escaping) is applied before verification. */
const PLAIN_SAFE_RE = /[\\*_~=+`[\]]/;

function serInline(runs, post = (s) => s) {
  // fast path: unformatted text without inline syntax characters is its own Markdown
  if (runs.every((r) => r.k === 'br' || (r.k === 't' && !r.m.length && !r.a && !PLAIN_SAFE_RE.test(r.text)))) {
    return post(runs.map((r) => (r.k === 'br' ? '\n' : r.text)).join(''));
  }
  const key = runsKey(runs);
  let s = '';
  let first = '';
  for (const it of ['auto', '*', '_']) {
    for (let level = 0; level <= 2; level++) {
      s = post(emitInline(runs, level, it));
      if (runsKey(parseInline(s)) === key) return s;
      first ||= s;
      if (it !== 'auto' && level < 2) level = 1; // only the strongest escaping for the alternatives
    }
  }
  return first;
}

/* =====================================================================
   Block grammar
   ===================================================================== */

const BLANK_RE = /^\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*?))?[ \t]*$/;
const TASK_RE = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cleanLang = (l) => (/^[\w+#.-]{1,30}$/.test(l || '') ? l : '');
const indentOf = (s) => s.replace(/\t/g, '    ').length;

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l)
    || isTableStart(lines, i) || !!imageLine(l) || !!audioLine(l);
}

function splitCells(line) {
  const t = line.trim();
  const cells = [];
  let cur = '';
  let endedWithPipe = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    endedWithPipe = false;
    if (c === '\\' && i + 1 < t.length) {
      if (t[i + 1] === '|') cur += PH_PIPE;
      else cur += c + t[i + 1];
      i++;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
      endedWithPipe = true;
    } else cur += c;
  }
  cells.push(cur);
  if (t.startsWith('|')) cells.shift();
  if (endedWithPipe) cells.pop();
  return cells.map((c) => c.trim());
}

const unPipe = (runs) => runs.map((r) => (r.k === 'br' ? r : { ...r, text: r.text.split(PH_PIPE).join('|'), a: r.a ? r.a.split(PH_PIPE).join('%7C') : r.a }));
const cellRuns = (src) => brToSpace(unPipe(parseInline(src)));

function buildLists(items) {
  const root = [];
  const levels = [];
  for (const it of items) {
    while (levels.length && it.indent < levels[levels.length - 1].indent) levels.pop();
    let top = levels[levels.length - 1];
    if (!top) { top = { indent: it.indent, container: root }; levels.push(top); }
    else if (it.indent > top.indent) {
      const lastList = top.container[top.container.length - 1];
      const parent = lastList.items[lastList.items.length - 1];
      top = { indent: it.indent, container: parent.lists };
      levels.push(top);
    }
    const cont = top.container;
    const last = cont[cont.length - 1];
    const item = { runs: it.runs, checked: !!it.checked, lists: it.lists ? [...it.lists] : [] };
    if (last && last.kind === it.kind) last.items.push(item);
    else cont.push({ type: 'list', kind: it.kind, start: it.kind === 'ol' ? (it.start || 1) : 1, items: [item] });
  }
  return root;
}

function readList(lines, i) {
  const items = [];
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (BLANK_RE.test(line)) {
      let k = i;
      while (k < n && BLANK_RE.test(lines[k])) k++;
      if (k < n && LIST_RE.test(lines[k]) && !HR_RE.test(lines[k])) { i = k; continue; }
      break;
    }
    if (HR_RE.test(line)) break;
    const m = LIST_RE.exec(line);
    if (m) {
      let content = m[3] || '';
      let kind = /\d/.test(m[2]) ? 'ol' : 'ul';
      let checked = false;
      const t = TASK_RE.exec(content);
      if (t) { kind = 'task'; checked = t[1] !== ' '; content = t[2] || ''; }
      items.push({ indent: indentOf(m[1]), kind, start: kind === 'ol' ? parseInt(m[2], 10) : 1, checked, text: [content.trim()] });
      i++;
      continue;
    }
    if (items.length && /^[ \t]+\S/.test(line) && !startsBlock([line.trim()], 0)) {
      items[items.length - 1].text.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  for (const it of items) it.runs = parseInline(it.text.join('\n'));
  return [buildLists(items), i];
}

function readBlocks(lines) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (BLANK_RE.test(line)) { i++; continue; }
    let m = FENCE_RE.exec(line);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      const body = [];
      i++;
      while (i < n) {
        const c = FENCE_CLOSE_RE.exec(lines[i]);
        if (c && c[1][0] === ch && c[1].length >= len) break;
        body.push(lines[i++]);
      }
      i++;
      out.push({ type: 'code', lang: cleanLang(m[2]), text: body.join('\n').replace(/\n+$/, '') });
      continue;
    }
    m = HEADING_RE.exec(line);
    if (m) {
      const text = (m[2] || '').replace(/(^|[ \t]+)#+[ \t]*$/, '');
      out.push({ type: 'h', level: Math.min(3, m[1].length), runs: brToSpace(parseInline(text)) });
      i++;
      continue;
    }
    if (HR_RE.test(line)) { out.push({ type: 'hr' }); i++; continue; }
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < n && QUOTE_RE.test(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push({ type: 'quote', blocks: readBlocks(inner) });
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitCells(line).map(cellRuns);
      i += 2;
      const rows = [];
      while (i < n && !BLANK_RE.test(lines[i]) && lines[i].includes('|')) rows.push(splitCells(lines[i++]).map(cellRuns));
      out.push({ type: 'table', head, rows: rows.map((r) => head.map((_, k) => r[k] || [])) });
      continue;
    }
    if (LIST_RE.test(line)) {
      const [lists, next] = readList(lines, i);
      out.push(...lists);
      i = next;
      continue;
    }
    const img = imageLine(line);
    if (img) { out.push({ type: 'img', ...img }); i++; continue; }
    const au = audioLine(line);
    if (au) { out.push({ type: 'audio', ...au }); i++; continue; }
    const para = [];
    while (i < n && !BLANK_RE.test(lines[i]) && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++].trim());
    out.push({ type: 'p', runs: parseInline(para.join('\n')) });
  }
  return out;
}

function normList(list) {
  for (const it of list.items) { it.runs = effectiveRuns(it.runs); it.lists = normListArray(it.lists); }
}
function normListArray(lists) {
  const out = [];
  for (const l of lists) {
    if (!l.items.length) continue;
    normList(l);
    const last = out[out.length - 1];
    if (last && last.kind === l.kind) last.items.push(...l.items);
    else out.push(l);
  }
  return out;
}

function normBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'p' || b.type === 'h') { b.runs = effectiveRuns(b.runs); if (!b.runs.length) continue; }
    if (b.type === 'table') { b.head = b.head.map(effectiveRuns); b.rows = b.rows.map((r) => r.map(effectiveRuns)); }
    if (b.type === 'quote') b.blocks = normBlocks(b.blocks);
    if (b.type === 'list') {
      if (!b.items.length) continue;
      normList(b);
      const last = out[out.length - 1];
      if (last && last.type === 'list' && last.kind === b.kind) { last.items.push(...b.items); continue; }
    }
    if (b.type === 'table' && !b.head.length) continue;
    out.push(b);
  }
  return out;
}

/** Markdown → normalised block AST. */
export function parseMd(md) {
  // eslint-disable-next-line no-control-regex
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0002]/g, '').split('\n');
  return normBlocks(readBlocks(lines));
}

/* =====================================================================
   AST → canonical Markdown
   ===================================================================== */

function escLine(line, prev) {
  if (!line) return line;
  // only a line the parser would read as a fence opener (```a``b``` is a code span, not a fence)
  const lead = FENCE_RE.test(line) && /^(`{3,}|~{3,})/.exec(line);
  if (lead) return lead[1].split('').map((c) => '\\' + c).join('') + line.slice(lead[1].length);
  if (/^#{1,6}(?:\s|$)/.test(line) || /^[-*+](?:\s|$)/.test(line) || /^>/.test(line) || HR_RE.test(line)) return '\\' + line;
  const m = /^(\d{1,9})([.)])(?:\s|$)/.exec(line);
  if (m) return m[1] + '\\' + line.slice(m[1].length);
  if (imageLine(line) || audioLine(line)) return '\\' + line;
  if (prev != null && prev.includes('|') && TABLE_SEP_RE.test(line)) return '\\' + line;
  return line;
}

const escLines = (s, first = (l) => l) => {
  const lines = s.split('\n');
  const out = [];
  lines.forEach((l, k) => out.push(k === 0 ? first(escLine(l, null)) : escLine(l, out[k - 1])));
  return out.join('\n');
};

function serList(list, indent) {
  const lines = [];
  list.items.forEach((it, k) => {
    const marker = list.kind === 'ol' ? `${list.start + k}. ` : list.kind === 'task' ? `- [${it.checked ? 'x' : ' '}] ` : '- ';
    const first = list.kind === 'task' ? (l) => l : (l) => (/^\[[ xX]\](?:\s|$)/.test(l) ? '\\' + l : l);
    const body = it.runs.length ? serInline(it.runs, (s) => escLines(s, first)).split('\n') : [''];
    lines.push(indent + marker + body[0]);
    for (const l of body.slice(1)) lines.push(indent + '  ' + l);
    for (const sub of it.lists) lines.push(...serList(sub, indent + '  '));
  });
  return lines;
}

function serBlock(b) {
  switch (b.type) {
    case 'p': return serInline(b.runs, (s) => escLines(s));
    case 'h': return '#'.repeat(b.level) + ' ' + serInline(b.runs, (s) => s.replace(/(^|\s)(#+)$/, '$1\\$2'));
    case 'list': return serList(b, '').join('\n');
    case 'quote': return b.blocks.length ? serBlocks(b.blocks).split('\n').map((l) => (l ? '> ' + l : '>')).join('\n') : '> ';
    case 'code': {
      const longest = Math.max(2, ...(b.text.match(/`+/g) || []).map((x) => x.length));
      const fence = '`'.repeat(longest + 1);
      return fence + b.lang + '\n' + (b.text ? b.text + '\n' : '') + fence;
    }
    case 'hr': return '---';
    case 'table': {
      const cell = (runs) => serInline(brToSpace(runs)).replace(/\|/g, '\\|');
      const row = (cells) => '| ' + cells.map(cell).join(' | ') + ' |';
      return [row(b.head), '|' + b.head.map(() => '---').join('|') + '|', ...b.rows.map(row)].join('\n');
    }
    case 'img': return `![${escPlain(b.alt)}](${b.src}${b.w ? ` "w=${b.w}"` : ''})`;
    case 'audio': return `[${escPlain(b.label)}](${b.src})`;
    default: return '';
  }
}

function serBlocks(blocks) {
  return blocks.map(serBlock).join('\n\n');
}

/** Serialize until stable (guarantees normalizeMd(normalizeMd(x)) === normalizeMd(x)). */
// Top-level blocks are independent once separated by a blank line (adjacent lists of
// the same kind are merged by normBlocks), so each block is serialized and verified
// on its own and memoised: while typing only the edited block is re-serialized.
const blockCache = new Map();

function serBlockVerified(b) {
  const key = JSON.stringify(b);
  const hit = blockCache.get(key);
  if (hit !== undefined) return hit;
  const s = serBlock(b);
  if (JSON.stringify(parseMd(s)) !== '[' + key + ']') return null;
  if (blockCache.size >= 5000) blockCache.clear();
  blockCache.set(key, s);
  return s;
}

/** Serialize a canonical AST; verified per block, else iterated to a fixed point. */
function serializeStable(ast) {
  const parts = [];
  for (const b of ast) {
    const s = serBlockVerified(b);
    if (s === null) return fixedPoint(serBlocks(ast));
    parts.push(s);
  }
  return parts.join('\n\n');
}

function fixedPoint(s) {
  for (let k = 0; k < 4; k++) {
    const t = serBlocks(parseMd(s));
    if (t === s) return s;
    s = t;
  }
  return s;
}

/** Canonical Markdown for any Markdown input. */
export function normalizeMd(md) {
  return serializeStable(parseMd(md));
}

/** Block AST → canonical Markdown (exported for tests / tooling). */
export const serializeMd = (blocks) => serBlocks(blocks);

/* =====================================================================
   AST → editor HTML
   ===================================================================== */

function renderRuns(runs) {
  let h = '';
  nest(runs, {
    open(x) { h += x.startsWith('a|') ? `<a href="${esc(x.slice(2))}" target="_blank" rel="noopener noreferrer">` : `<${MARK_TAG[x]}>`; },
    close(x) { h += x.startsWith('a|') ? '</a>' : `</${MARK_TAG[x]}>`; },
    leaf(r) { h += r.k === 'br' ? '<br>' : r.k === 'c' ? `<code>${esc(r.text)}</code>` : esc(r.text); },
  });
  return h;
}

function renderList(l, ed) {
  const tag = l.kind === 'ol' ? 'ol' : 'ul';
  const attrs = l.kind === 'task' ? ' data-type="task"' : l.kind === 'ol' && l.start !== 1 ? ` start="${l.start}"` : '';
  const items = l.items.map((it) => {
    const body = renderRuns(it.runs) || (ed ? '<br>' : '');
    const subs = it.lists.map((s) => renderList(s, ed)).join('');
    return l.kind === 'task'
      ? `<li data-checked="${it.checked}"><span class="rt-check" contenteditable="false" role="checkbox" aria-checked="${it.checked}"></span>${body}${subs}</li>`
      : `<li>${body}${subs}</li>`;
  }).join('');
  return `<${tag}${attrs}>${items}</${tag}>`;
}

function renderBlock(b, ed) {
  const br = ed ? '<br>' : '';
  switch (b.type) {
    case 'p': return `<p>${renderRuns(b.runs) || br}</p>`;
    case 'h': return `<h${b.level}>${renderRuns(b.runs) || br}</h${b.level}>`;
    case 'list': return renderList(b, ed);
    case 'quote': return `<blockquote>${b.blocks.length ? b.blocks.map((x) => renderBlock(x, ed)).join('') : `<p>${br}</p>`}</blockquote>`;
    case 'code': return `<pre><code${b.lang ? ` data-lang="${esc(b.lang)}"` : ''}>${b.text ? esc(b.text) : br}</code></pre>`;
    case 'hr': return '<hr>';
    case 'table': {
      const cell = (tag, runs) => `<${tag}>${renderRuns(runs) || br}</${tag}>`;
      return `<table><thead><tr>${b.head.map((c) => cell('th', c)).join('')}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => cell('td', c)).join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'img': {
      const s = esc(b.src);
      const media = b.src.startsWith('nm-media:');
      return `<figure class="rt-img" contenteditable="false" data-src="${s}"${b.w ? ` data-w="${b.w}"` : ''}><img ${media ? `data-src="${s}"` : `src="${s}"`} alt="${esc(b.alt)}" loading="lazy"></figure>`;
    }
    case 'audio': {
      const s = esc(b.src);
      return `<figure class="rt-audio" contenteditable="false" data-src="${s}"><audio controls preload="none" data-src="${s}"></audio><figcaption>${esc(b.label)}</figcaption></figure>`;
    }
    default: return '';
  }
}

/** Markdown → editor DOM (safe HTML string). */
export function mdToHtml(md, { editable = true } = {}) {
  return parseMd(md).map((b) => renderBlock(b, editable)).join('');
}

/* =====================================================================
   DOM → AST
   ===================================================================== */

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE',
  'FIGURE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'ADDRESS', 'DL', 'DT', 'DD', 'FIGCAPTION',
  'DETAILS', 'SUMMARY', 'CENTER', 'FORM', 'FIELDSET', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'BODY', 'HTML']);
const BLOCK_SELECTOR = [...BLOCK_TAGS].map((t) => t.toLowerCase()).join(',');
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'BUTTON',
  'INPUT', 'SELECT', 'TEXTAREA', 'HEAD', 'META', 'LINK', 'TITLE', 'VIDEO', 'SOURCE', 'TRACK', 'MAP', 'AREA', 'DIALOG', 'MATH', 'OPTION']);

const tagOf = (n) => String(n.nodeName || '').toUpperCase();
const styleOf = (el) => String(el.getAttribute?.('style') || '').toLowerCase();

function isIgnored(el) {
  const tag = tagOf(el);
  if (SKIP_TAGS.has(tag)) return true;
  if (el.hasAttribute('data-rt-ui') || el.classList?.contains('rt-check')) return true;
  if (tag !== 'FIGURE' && el.getAttribute('contenteditable') === 'false') return true;
  const st = styleOf(el);
  return /mso-list\s*:\s*ignore/.test(st) || /display\s*:\s*none/.test(st);
}

function isHighlightColor(v) {
  const s = v.trim();
  if (/^(yellow|#ff0|#ffff00)\b/.test(s)) return true;
  let rgb = null;
  let m = /^#([0-9a-f]{6})\b/.exec(s);
  if (m) rgb = [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16));
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/.exec(s);
  if (m) { if (m[4] != null && Number(m[4]) === 0) return false; rgb = [m[1], m[2], m[3]].map(Number); }
  return !!rgb && rgb[0] > 200 && rgb[1] > 180 && rgb[2] < 150;
}

function inlineCtx(el, ctx) {
  const tag = tagOf(el);
  const st = styleOf(el);
  const m = new Set(ctx.m);
  let { a, code } = ctx;
  if (tag === 'B' || tag === 'STRONG') m.add('b');
  if (['I', 'EM', 'CITE', 'DFN', 'VAR'].includes(tag)) m.add('i');
  if (tag === 'U' || tag === 'INS') m.add('u');
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.add('s');
  if (tag === 'MARK') m.add('h');
  if (['CODE', 'KBD', 'SAMP', 'TT'].includes(tag)) code = true;
  if (tag === 'A' && !a) a = safeHref(el.getAttribute('href'));
  if (st) {
    const fw = /font-weight\s*:\s*([a-z0-9]+)/.exec(st);
    if (fw) {
      const v = fw[1];
      if (v === 'bold' || v === 'bolder' || Number(v) >= 600) m.add('b');
      else if (v === 'normal' || v === 'lighter' || (Number(v) > 0 && Number(v) < 600)) m.delete('b');
    }
    const fs = /font-style\s*:\s*(italic|oblique|normal)/.exec(st);
    if (fs) { if (fs[1] === 'normal') m.delete('i'); else m.add('i'); }
    const td = /text-decoration(?:-line)?\s*:\s*([^;]+)/.exec(st);
    if (td) { if (td[1].includes('underline')) m.add('u'); if (td[1].includes('line-through')) m.add('s'); }
    const hl = /mso-highlight\s*:\s*([^;]+)/.exec(st);
    if (hl && !/none/.test(hl[1])) m.add('h');
    const bg = /background(?:-color)?\s*:\s*([^;]+)/.exec(st);
    if (bg && isHighlightColor(bg[1])) m.add('h');
  }
  return { m: [...m], a, code };
}

const ROOT_CTX = { m: [], a: null, code: false };

function figureBlock(fig) {
  if (fig.hasAttribute('data-uploading')) return null;
  const audio = fig.querySelector('audio');
  const img = fig.querySelector('img');
  if (fig.classList.contains('rt-audio') || (audio && !img)) {
    const src = safeMediaSrc(fig.getAttribute('data-src') || audio?.getAttribute('data-src'));
    if (!src || !src.startsWith('nm-media:') || !AUDIO_EXT_RE.test(src)) return null;
    return { type: 'audio', src, label: cleanText(fig.querySelector('figcaption')?.textContent) };
  }
  if (fig.classList.contains('rt-img') || img) {
    const src = safeMediaSrc(fig.getAttribute('data-src') || img?.getAttribute('data-src'));
    if (!src) return null;
    return { type: 'img', src, alt: cleanText(img?.getAttribute('alt')), w: normW(fig.getAttribute('data-w')) };
  }
  return undefined; // not a media figure
}

function imgBlock(img) {
  const src = safeMediaSrc(img.getAttribute('data-src') || img.getAttribute('src'));
  return src ? { type: 'img', src, alt: cleanText(img.getAttribute('alt')), w: normW(img.getAttribute('data-w')) } : null;
}

/** Inline content of `node` into `out`. hooks.list(el) receives nested UL/OL (list items). */
function inlineNode(node, ctx, out, hooks = {}) {
  if (node.nodeType === 3) {
    if (node.data) out.push({ k: ctx.code ? 'c' : 't', text: node.data, m: ctx.m, a: ctx.a });
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = tagOf(node);
  if (tag === 'INPUT' && hooks.checkbox && String(node.getAttribute('type')).toLowerCase() === 'checkbox') { hooks.checkbox(node); return; }
  if (isIgnored(node)) return;
  if (tag === 'BR') { out.push({ k: 'br' }); return; }
  if (tag === 'IMG') { const b = imgBlock(node); if (b) out.push({ k: 'blk', block: b }); return; }
  if (tag === 'FIGURE') {
    const b = figureBlock(node);
    if (b) { out.push({ k: 'blk', block: b }); return; }
    if (b === null) return;
  }
  if ((tag === 'UL' || tag === 'OL') && hooks.list) { hooks.list(node); return; }
  if (tag === 'HR') { out.push({ k: 'blk', block: { type: 'hr' } }); return; }
  const block = BLOCK_TAGS.has(tag);
  if (block) out.push({ k: 'bb' });
  const c2 = block ? ctx : inlineCtx(node, ctx);
  for (const ch of node.childNodes) inlineNode(ch, c2, out, hooks);
  if (block) out.push({ k: 'bb' });
}

function inlineOf(el, ctx) {
  const out = [];
  for (const ch of el.childNodes) inlineNode(ch, ctx, out);
  return out.filter((r) => r.k !== 'blk');
}

function paraBlocks(pend) {
  const blocks = [];
  let cur = [];
  const push = () => { const runs = normRuns(cur); if (runs.length) blocks.push({ type: 'p', runs }); cur = []; };
  for (let j = 0; j < pend.length; j++) {
    const r = pend[j];
    if (r.k === 'blk') { push(); blocks.push(r.block); continue; }
    if (r.k === 'br' || r.k === 'bb') {
      let k = j + 1;
      while (k < pend.length && pend[k].k === 't' && !pend[k].text.replace(ZW_RE, '').trim()) k++;
      if (r.k === 'bb' || pend[k]?.k === 'br') { push(); j = r.k === 'bb' ? j : k; continue; }
    }
    cur.push(r);
  }
  push();
  return blocks;
}

function msoLevel(el) {
  if (el.nodeType !== 1) return 0;
  const m = /mso-list\s*:\s*l\d+\s+level(\d+)/.exec(styleOf(el));
  return m ? Number(m[1]) : 0;
}

function domListItems(el, ctx, level) {
  const items = [];
  const isOl = tagOf(el) === 'OL';
  const taskList = el.getAttribute('data-type') === 'task' || el.classList.contains('contains-task-list');
  let start = isOl ? parseInt(el.getAttribute('start'), 10) || 1 : 1;
  for (const ch of el.childNodes) {
    if (ch.nodeType === 1 && (tagOf(ch) === 'UL' || tagOf(ch) === 'OL')) { items.push(...domListItems(ch, ctx, level + 1)); continue; }
    if (ch.nodeType === 1 && isIgnored(ch)) continue;
    if (ch.nodeType === 3 && !ch.data.trim()) continue;
    if (ch.nodeType !== 1 && ch.nodeType !== 3) continue;
    const aria = ch.nodeType === 1 ? parseInt(ch.getAttribute('aria-level'), 10) : 0;
    const lvl = level + (aria > 1 ? aria - 1 : 0);
    let checked = ch.nodeType === 1 && ch.hasAttribute('data-checked') ? ch.getAttribute('data-checked') === 'true' : null;
    const sub = [];
    const runs = [];
    const hooks = {
      list: (l) => sub.push(...domListItems(l, ctx, lvl + 1)),
      checkbox: (inp) => { checked = inp.hasAttribute('checked') || !!inp.checked; },
    };
    if (ch.nodeType === 1 && tagOf(ch) === 'LI') for (const x of ch.childNodes) inlineNode(x, ctx, runs, hooks);
    else inlineNode(ch, ctx, runs, hooks);
    const kind = checked !== null || taskList ? 'task' : isOl ? 'ol' : 'ul';
    items.push({ indent: lvl, kind, start, checked: !!checked, runs: normRuns(runs.filter((r) => r.k !== 'blk')) });
    start = undefined;
    items.push(...sub);
  }
  return items;
}

function domTable(el) {
  const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el)
    .map((tr) => [...tr.children].filter((c) => tagOf(c) === 'TD' || tagOf(c) === 'TH').map((c) => brToSpace(inlineOf(c, ROOT_CTX))));
  if (!rows.length) return null;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: cols }, (_, k) => r[k] || []);
  return { type: 'table', head: pad(rows[0]), rows: rows.slice(1).map(pad) };
}

function preText(el) {
  let s = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1) {
        const t = tagOf(c);
        if (t === 'BR') s += '\n';
        else if (isIgnored(c)) continue;
        else if (BLOCK_TAGS.has(t)) { if (s && !s.endsWith('\n')) s += '\n'; walk(c); if (!s.endsWith('\n')) s += '\n'; } else walk(c);
      }
    }
  };
  walk(el);
  return s.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(ZW_RE, '').replace(/\n+$/, '');
}

function domBlocks(parent, ctx) {
  const out = [];
  let pend = [];
  const flush = () => { if (pend.length) { out.push(...paraBlocks(pend)); pend = []; } };
  const kids = [...parent.childNodes];
  for (let k = 0; k < kids.length; k++) {
    const node = kids[k];
    if (node.nodeType === 3) { inlineNode(node, ctx, pend); continue; }
    if (node.nodeType !== 1 || isIgnored(node)) continue;
    const tag = tagOf(node);
    if (msoLevel(node)) {
      flush();
      const items = [];
      while (k < kids.length) {
        const n = kids[k];
        if (n.nodeType === 3 && !n.data.trim()) { k++; continue; }
        if (n.nodeType === 8) { k++; continue; }
        const lvl = msoLevel(n);
        if (!lvl) break;
        const bullet = n.querySelector('[style*="mso-list"]')?.textContent || '';
        items.push({ indent: lvl - 1, kind: /^\s*(\d+|[a-zA-Z]|[ivxlcdm]+)[.)]/i.test(bullet) ? 'ol' : 'ul', start: 1, runs: normRuns(inlineOf(n, ctx)) });
        k++;
      }
      k--;
      out.push(...buildLists(items));
      continue;
    }
    if (!BLOCK_TAGS.has(tag) && !(node.firstElementChild && node.querySelector(BLOCK_SELECTOR))) { inlineNode(node, ctx, pend); continue; }
    flush();
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        out.push({ type: 'h', level: Math.min(3, Number(tag[1])), runs: brToSpace(inlineOf(node, ctx)) });
        break;
      case 'UL': case 'OL':
        out.push(...buildLists(domListItems(node, ctx, 0)));
        break;
      case 'BLOCKQUOTE':
        out.push({ type: 'quote', blocks: normBlocks(domBlocks(node, ctx)) });
        break;
      case 'PRE': {
        const code = node.querySelector('code');
        const cls = `${node.className || ''} ${code?.className || ''}`;
        const lang = code?.getAttribute('data-lang') || node.getAttribute('data-lang') || (/(?:language|lang)-([\w+#.-]+)/.exec(cls) || [])[1];
        out.push({ type: 'code', lang: cleanLang(lang), text: preText(node) });
        break;
      }
      case 'HR': out.push({ type: 'hr' }); break;
      case 'TABLE': { const t = domTable(node); if (t) out.push(t); break; }
      case 'FIGURE': {
        const b = figureBlock(node);
        if (b) out.push(b);
        else if (b === undefined) out.push(...domBlocks(node, ctx));
        break;
      }
      default:
        out.push(...domBlocks(node, BLOCK_TAGS.has(tag) ? ctx : inlineCtx(node, ctx)));
    }
  }
  flush();
  return out;
}

/** Editor DOM (Element / DocumentFragment / HTML string) → canonical Markdown. */
export function htmlToMd(root) {
  if (root == null) return '';
  if (typeof root === 'string') {
    const t = document.createElement('template');
    t.innerHTML = root;
    root = t.content;
  }
  return serializeStable(normBlocks(domBlocks(root, ROOT_CTX)));
}
