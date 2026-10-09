// Notes editor toolkit: a small, safe Markdown renderer, textarea formatting
// operations (undo-friendly), note statistics, templates and a light popover.
//
// Markdown safety model: every piece of user text goes through esc() BEFORE any
// markup is added; only tags generated here are ever emitted. Links are allowed
// for http(s)/mailto only and always open with rel="noopener noreferrer".
import { esc, html, raw } from '../utils/dom.js';
import { icon } from './icons.js';
import { today, startOfWeek, endOfWeek } from '../utils/date.js';
import { day } from '../utils/format.js';
import { imageLine, audioLine, safeMediaSrc } from './rich/markdown.js';

/* =====================================================================
   1. Markdown → HTML string (trusted: built from escaped text only)
   ===================================================================== */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\](?:\s+(.*))?$/;
const FENCE_RE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BLANK_RE = /^\s*$/;
// Backslash escapes the rich editor's serializer writes for literal syntax characters.
const ESCAPE_RE = /\\([!-/:-@[-`{-~])/g;

const link = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/** Preview <img>: nm-media sources are resolved later by hydrateMedia (data-src), https used directly. */
function imgTag({ src, alt, w }) {
  const s = esc(src);
  return `<img ${src.startsWith('nm-media:') ? `data-src="${s}"` : `src="${s}" referrerpolicy="no-referrer"`} alt="${esc(alt)}" loading="lazy"${w ? ` data-w="${w}"` : ''}>`;
}

/** A line that is only an image or an audio recording → preview figure HTML (else null). */
function mediaBlock(line) {
  const img = imageLine(line);
  if (img) return `<figure class="md-img"${img.w ? ` data-w="${img.w}"` : ''}>${imgTag(img)}</figure>`;
  const au = audioLine(line);
  if (au) return `<figure class="md-audio"><audio controls preload="none" data-src="${esc(au.src)}"></audio><figcaption>${esc(au.label)}</figcaption></figure>`;
  return null;
}

/** Emphasis on an already-escaped string. */
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>')
    .replace(/\+\+(?=\S)([\s\S]*?\S)\+\+/g, '<u>$1</u>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
}

/** Inline Markdown for one line of raw text. */
export function inlineMd(src) {
  const tokens = [];
  const plain = [];
  const keep = (h, p = '') => { plain.push(p); return `\u0000${tokens.push(h) - 1}\u0000`; };
  const restorePlain = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => plain[Number(i)]);
  let s = String(src ?? '').replace(/\u0000/g, '');
  // code spans and backslash escapes (leftmost wins, so "\`" is never a code fence)
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)|\\([!-/:-@[-`{-~])/g, (m, fence, code, ch) => {
    if (fence) {
      const c = /^ [\s\S]* $/.test(code) && /[^ ]/.test(code) ? code.slice(1, -1) : code;
      return keep(`<code>${esc(c)}</code>`, c);
    }
    return keep(esc(ch), ch);
  });
  s = s.replace(/!\[((?:[^\]\n])*)\]\(\s*(\S+?)(?:\s+"([^"\n]*)")?\s*\)/g, (m, alt, url, title) => {
    const src = safeMediaSrc(url);
    if (!src) return m;
    const w = /^w=(\d{1,3})$/.exec(title || '');
    const n = w ? Math.min(100, Math.max(10, Number(w[1]))) : null;
    return keep(imgTag({ src, alt: restorePlain(alt), w: n === 100 ? null : n }));
  });
  s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, (m, text, url) =>
    SAFE_URL.test(url) ? keep(link(url, emphasis(esc(text)))) : m);
  s = s.replace(/\b(?:https?:\/\/|mailto:)[^\s<>"'`\u0000]*[^\s<>"'`.,;:!?)\]\u0000]/g, (url) => keep(link(url, esc(url))));
  s = emphasis(esc(s));
  for (let k = 0; k < 3 && s.includes('\u0000'); k++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
  return s;
}

/** Split a table row on unescaped pipes ("\|" stays a literal pipe inside the cell). */
const splitRow = (l) => l.trim().replace(/\\\\/g, '\u0002').replace(/\\\|/g, '\u0001')
  .replace(/^\|/, '').replace(/\|$/, '').split('|')
  .map((c) => c.trim().replace(/\u0001/g, '\\|').replace(/\u0002/g, '\\\\'));

function isBlockStart(line) {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || !!mediaBlock(line);
}

function renderList(lines, i, offset) {
  let out = '';
  const stack = []; // { indent, type }
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK_RE.test(line)) {
      // a blank line inside a list continues it when the next line is an item
      if (i + 1 < lines.length && LIST_RE.test(lines[i + 1])) { i++; continue; }
      break;
    }
    const m = line.match(LIST_RE);
    if (!m) {
      if (stack.length && /^\s{2,}\S/.test(line) && !isBlockStart(line.trim())) {
        out += '<br>' + inlineMd(line.trim());
        i++;
        continue;
      }
      break;
    }
    if (HR_RE.test(line)) break;
    const indent = m[1].replace(/\t/g, '    ').length;
    const type = /\d/.test(m[2]) ? 'ol' : 'ul';
    while (stack.length && indent < stack[stack.length - 1].indent) out += `</li></${stack.pop().type}>`;
    const top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      const start = type === 'ol' ? parseInt(m[2], 10) : 1;
      stack.push({ indent, type });
      out += `<${type}${start !== 1 ? ` start="${start}"` : ''}>`;
    } else if (top.type !== type) {
      out += `</li></${top.type}><${type}>`;
      top.type = type;
    } else {
      out += '</li>';
    }
    const t = m[3].match(TASK_RE);
    if (t) {
      const done = t[1] !== ' ';
      out += `<li class="md-task${done ? ' is-done' : ''}"><label><input type="checkbox" data-line="${offset + i}"${done ? ' checked' : ''} aria-label="Đánh dấu hoàn thành" /><span>${inlineMd(t[2] || '')}</span></label>`;
    } else {
      out += `<li>${inlineMd(m[3])}`;
    }
    i++;
  }
  while (stack.length) out += `</li></${stack.pop().type}>`;
  return [out, i];
}

function renderBlocks(lines, offset) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (BLANK_RE.test(line)) { i++; continue; }

    let m = line.match(FENCE_RE);
    if (m) {
      const fence = m[1];
      const lang = m[2];
      const body = [];
      i++;
      while (i < n && !new RegExp(`^\\s{0,3}${fence}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(`<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    m = line.match(HEADING_RE);
    if (m) {
      const l = m[1].length;
      out.push(`<h${l}>${inlineMd(m[2])}</h${l}>`);
      i++;
      continue;
    }
    if (HR_RE.test(line)) { out.push('<hr />'); i++; continue; }
    if (QUOTE_RE.test(line)) {
      const start = i;
      const inner = [];
      while (i < n && QUOTE_RE.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${renderBlocks(inner, offset + start)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < n && lines[i].includes('|') && !BLANK_RE.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, k) => `<td>${inlineMd(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      const [h, next] = renderList(lines, i, offset);
      out.push(h);
      i = next;
      continue;
    }
    const media = mediaBlock(line);
    if (media) { out.push(media); i++; continue; }
    const para = [];
    while (i < n && !BLANK_RE.test(lines[i]) && (para.length === 0 || !isBlockStart(lines[i]))) para.push(lines[i++]);
    out.push(`<p>${para.map((l) => inlineMd(l.trim())).join('<br />')}</p>`);
  }
  return out.join('');
}

/** Markdown source → SafeHTML. Checklist boxes carry data-line (0-based source line). */
export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  return raw(renderBlocks(lines, 0));
}

/** Flip "- [ ]" ↔ "- [x]" on a given source line. */
export function toggleTaskLine(content, lineIndex) {
  const lines = String(content).split('\n');
  const l = lines[lineIndex];
  if (l == null) return content;
  lines[lineIndex] = l.replace(/^(\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/, (_, pre, c) => `${pre}[${c === ' ' ? 'x' : ' '}]`);
  return lines.join('\n');
}

/* =====================================================================
   2. Plain text helpers: snippet, title fallback, stats, checklist
   ===================================================================== */

/**
 * Strip Markdown syntax → readable plain text (for snippets / search highlight).
 * Media never leaks its nm-media: URL: an image becomes its alt text, an audio
 * recording "🎙 label". Backslash-escaped characters come out literally.
 */
export function plainText(src) {
  const kept = [];
  return String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/^[ \t]*\[((?:\\.|[^\]\\\n])*)\]\([ \t]*nm-media:[^\s)]+\.(?:webm|ogg|m4a|mp4|mp3|wav)[ \t]*\)[ \t]*$/gim, (_, l) => `🎙 ${l}`)
    .replace(ESCAPE_RE, (_, c) => `\u0000${kept.push(c) - 1}\u0000`)
    .replace(/^\s{0,3}(```|~~~).*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]\s*/gm, '☐ ')
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/gm, '• ')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(==|\+\+)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

/** One-line snippet (≤ max chars) skipping the line that duplicates the title. */
export function snippet(content, title = '', max = 160) {
  const t = String(title).trim().toLowerCase();
  const lines = plainText(content).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length && t && lines[0].toLowerCase() === t) lines.shift();
  const s = lines.join(' · ').replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** Display title: the title, else the first line of content, else a placeholder. */
export function displayTitle(note) {
  const t = String(note?.title ?? '').trim();
  if (t) return t;
  const first = plainText(note?.content).split('\n').map((l) => l.replace(/^[☐•]\s*/, '').trim()).find(Boolean);
  return first ? (first.length > 80 ? first.slice(0, 79) + '…' : first) : 'Ghi chú chưa đặt tên';
}

export function checklistProgress(content) {
  let total = 0, done = 0;
  for (const m of String(content ?? '').matchAll(/^\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]/gm)) {
    total++;
    if (m[1] !== ' ') done++;
  }
  return { total, done };
}

/** Words = Vietnamese syllables / tokens. Reading speed ≈ 230 tiếng/phút. */
export function noteStats(content) {
  const text = plainText(content);
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  return { words, chars: String(content ?? '').length, minutes: words ? Math.max(1, Math.round(words / 230)) : 0, ...checklistProgress(content) };
}

/** Unchecked checklist items → [{ line, text }]. */
export function openChecklistItems(content) {
  const out = [];
  String(content ?? '').split('\n').forEach((l, line) => {
    const m = l.match(/^\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[ \]\s+(.*\S)\s*$/);
    if (m) out.push({ line, text: plainText(m[1]).trim() });
  });
  return out.filter((x) => x.text);
}

/** The raw line around the caret → a task title (markers stripped). */
export function lineToTaskTitle(line) {
  return plainText(String(line ?? '').replace(/^\s*(?:>\s?)*/, ''))
    .replace(/^[☐•]\s*/, '')
    .trim()
    .slice(0, 200);
}

/* =====================================================================
   3. Textarea formatting (uses execCommand('insertText') so Ctrl+Z works)
   ===================================================================== */

export function replaceRange(ta, start, end, text, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok || ta.value.slice(start, start + text.length) !== text) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const a = selStart ?? start + text.length;
  ta.setSelectionRange(a, selEnd ?? a);
}

/** Toggle an inline wrapper (**, _, `, ~~, ==) around the selection. */
export function wrapSelection(ta, mark, endMark = mark, placeholder = 'văn bản') {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  if (v.slice(s - mark.length, s) === mark && v.slice(e, e + endMark.length) === endMark) {
    return replaceRange(ta, s - mark.length, e + endMark.length, sel, s - mark.length, s - mark.length + sel.length);
  }
  if (sel.length >= mark.length + endMark.length && sel.startsWith(mark) && sel.endsWith(endMark)) {
    const inner = sel.slice(mark.length, sel.length - endMark.length);
    return replaceRange(ta, s, e, inner, s, s + inner.length);
  }
  const text = sel || placeholder;
  replaceRange(ta, s, e, mark + text + endMark, s + mark.length, s + mark.length + text.length);
}

function lineBounds(ta) {
  const v = ta.value;
  const s = ta.selectionStart;
  let e = ta.selectionEnd;
  if (e > s && v[e - 1] === '\n') e--;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e);
  if (le < 0) le = v.length;
  return { ls, le, lines: v.slice(ls, le).split('\n') };
}

const STRIP = {
  task: /^(\s*)[-*+]\s+\[[ xX]\]\s?/,
  ul: /^(\s*)[-*+]\s+/,
  ol: /^(\s*)\d{1,9}[.)]\s+/,
  quote: /^(\s*)>\s?/,
  heading: /^(\s*)#{1,6}\s+/,
};

/** Line-level formats: 'ul' | 'ol' | 'task' | 'quote' | 'h1' | 'h2' | 'h3'. Toggles when already applied. */
export function toggleLines(ta, kind) {
  const { ls, le, lines } = lineBounds(ta);
  const level = /^h(\d)$/.exec(kind)?.[1];
  const has = (l) => {
    if (level) return new RegExp(`^\\s*#{${level}}\\s`).test(l);
    if (kind === 'ul') return STRIP.ul.test(l) && !STRIP.task.test(l);
    return STRIP[kind].test(l);
  };
  const filled = lines.filter((l) => l.trim());
  const isOn = filled.length > 0 && filled.every(has);
  let n = 0;
  const out = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l;
    let body;
    if (level) body = l.replace(STRIP.heading, '$1');
    else if (kind === 'quote') body = l.replace(STRIP.quote, '$1');
    else body = l.replace(STRIP.task, '$1').replace(STRIP.ul, '$1').replace(STRIP.ol, '$1');
    if (isOn) return body;
    const indent = body.match(/^\s*/)[0];
    const rest = body.slice(indent.length);
    const prefix = level ? '#'.repeat(Number(level)) + ' '
      : kind === 'ul' ? '- ' : kind === 'task' ? '- [ ] ' : kind === 'ol' ? `${++n}. ` : '> ';
    return indent + prefix + rest;
  });
  const text = out.join('\n');
  const caret = ls + text.length - (le - Math.max(ta.selectionEnd, ls));
  if (lines.length > 1) replaceRange(ta, ls, le, text, ls, ls + text.length);
  else replaceRange(ta, ls, le, text, Math.max(ls, Math.min(caret, ls + text.length)));
}

/** Indent (+1) / outdent (-1) the selected lines by two spaces. */
export function indentLines(ta, dir) {
  const { ls, le, lines } = lineBounds(ta);
  const out = lines.map((l) => (dir > 0 ? '  ' + l : l.replace(/^ {1,2}|^\t/, '')));
  const text = out.join('\n');
  if (lines.length > 1) replaceRange(ta, ls, le, text, ls, ls + text.length);
  else {
    const delta = text.length - (le - ls);
    replaceRange(ta, ls, le, text, Math.max(ls, ta.selectionStart + delta));
  }
}

/** Insert a block (hr, code fence) on its own line(s) after the caret line. */
export function insertBlock(ta, kind) {
  const v = ta.value;
  const { ls, le } = lineBounds(ta);
  if (kind === 'code') {
    const sel = v.slice(ta.selectionStart, ta.selectionEnd);
    if (sel) {
      const text = '```\n' + sel.replace(/\n$/, '') + '\n```';
      return replaceRange(ta, ta.selectionStart, ta.selectionEnd, text, ta.selectionStart + 4, ta.selectionStart + 4 + sel.replace(/\n$/, '').length);
    }
    const lineEmpty = !v.slice(ls, le).trim();
    const pre = lineEmpty ? '' : '\n';
    const at = lineEmpty ? ls : le;
    return replaceRange(ta, at, lineEmpty ? le : le, pre + '```\n\n```', at + pre.length + 4);
  }
  if (kind === 'hr') {
    const pre = v.slice(ls, le).trim() ? '\n' : '';
    return replaceRange(ta, le, le, pre + '\n---\n', le + pre.length + 5);
  }
}

export function insertLink(ta) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  if (/^(https?:\/\/|mailto:)\S+$/i.test(sel)) {
    return replaceRange(ta, s, e, `[liên kết](${sel})`, s + 1, s + 10);
  }
  const label = sel || 'văn bản';
  const text = `[${label}](https://)`;
  if (sel) replaceRange(ta, s, e, text, s + label.length + 3, s + label.length + 11);
  else replaceRange(ta, s, e, text, s + 1, s + 1 + label.length);
}

/** Enter inside a list/quote continues it; Enter on an empty item ends the list. Returns true when handled. */
export function continueList(ta) {
  const v = ta.value;
  const s = ta.selectionStart;
  if (s !== ta.selectionEnd) return false;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', s);
  if (le < 0) le = v.length;
  const before = v.slice(ls, s);
  const m = before.match(/^(\s*)((?:[-*+]\s+\[[ xX]\]|[-*+]|(\d{1,9})([.)])|>)\s+)(.*)$/s);
  if (!m) return false;
  if (!m[5].trim() && !v.slice(s, le).trim()) {
    replaceRange(ta, ls, le, '', ls); // empty item → leave the list
    return true;
  }
  let next = m[2];
  if (m[3]) next = `${Number(m[3]) + 1}${m[4]} `;
  else next = next.replace(/\[[xX]\]/, '[ ]');
  replaceRange(ta, s, s, '\n' + m[1] + next);
  return true;
}

export function currentLine(ta) {
  const v = ta.value;
  const s = ta.selectionStart;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', s);
  if (le < 0) le = v.length;
  return { text: v.slice(ls, le), index: v.slice(0, ls).split('\n').length - 1 };
}

/* =====================================================================
   4. Templates
   ===================================================================== */

export function noteTemplates() {
  const d = day(today(), 'medium');
  const wk = `${day(startOfWeek(today()))} – ${day(endOfWeek(today()))}`;
  return [
    { id: 'blank', label: 'Trang trắng', desc: 'Bắt đầu từ con số không.', kind: 'note', icon: 'note', title: '', content: '' },
    { id: 'checklist', label: 'Danh sách kiểm', desc: 'Những việc cần đánh dấu.', kind: 'checklist', icon: 'tasks', title: '', content: '- [ ] ' },
    {
      id: 'meeting', label: 'Biên bản họp', desc: 'Thành phần, thảo luận, quyết định, việc cần làm.', kind: 'meeting', icon: 'user',
      title: `Họp — ${d}`,
      content: `**Thời gian:** ${d}\n**Thành phần:** \n**Chủ trì:** \n\n## Mục tiêu\n- \n\n## Nội dung thảo luận\n1. \n\n## Quyết định\n- \n\n## Việc cần làm\n- [ ] Ai — việc gì — hạn\n\n## Ghi chú thêm\n`,
    },
    {
      id: 'journal', label: 'Nhật ký ngày', desc: 'Cảm nhận, biết ơn, bài học, ngày mai.', kind: 'journal', icon: 'calendar',
      title: `Nhật ký ${d}`,
      content: `## Hôm nay thế nào?\n\n\n## Ba điều biết ơn\n1. \n2. \n3. \n\n## Đã làm được\n- \n\n## Bài học\n> \n\n## Cho ngày mai\n- [ ] \n`,
    },
    {
      id: 'week', label: 'Kế hoạch tuần', desc: 'Mục tiêu, ưu tiên và lịch từng ngày.', kind: 'checklist', icon: 'board',
      title: `Kế hoạch tuần ${wk}`,
      content: `## Mục tiêu tuần\n1. \n2. \n3. \n\n## Ưu tiên cao\n- [ ] \n- [ ] \n\n## Theo ngày\n**Thứ Hai**\n- [ ] \n\n**Thứ Ba**\n- [ ] \n\n**Thứ Tư**\n- [ ] \n\n**Thứ Năm**\n- [ ] \n\n**Thứ Sáu**\n- [ ] \n\n**Cuối tuần**\n- [ ] \n\n## Nhìn lại\n> \n`,
    },
    {
      id: 'brainstorm', label: 'Động não', desc: 'Câu hỏi trọng tâm, ý tưởng, chấm điểm.', kind: 'note', icon: 'sparkle',
      title: 'Động não — ',
      content: `## Câu hỏi trọng tâm\n> Làm thế nào để …?\n\n## Ý tưởng\n- \n- \n- \n\n## Chấm điểm\n| Ý tưởng | Tác động | Công sức |\n|---|---|---|\n|  | Cao | Thấp |\n\n## Thử ngay\n- [ ] \n`,
    },
    {
      id: 'project', label: 'Checklist dự án', desc: 'Khởi động → thực hiện → nghiệm thu → bàn giao.', kind: 'checklist', icon: 'flag',
      title: 'Dự án: ',
      content: `**Mục tiêu:** \n**Hạn chót:** \n**Phụ trách:** \n\n## Khởi động\n- [ ] Xác định phạm vi & tiêu chí hoàn thành\n- [ ] Liệt kê các bên liên quan\n- [ ] Lập kế hoạch & các mốc\n\n## Thực hiện\n- [ ] \n- [ ] \n\n## Kiểm tra\n- [ ] Rà soát chất lượng\n- [ ] Nghiệm thu\n\n## Bàn giao\n- [ ] Tài liệu hướng dẫn\n- [ ] Tổng kết bài học\n`,
    },
    {
      id: 'report', label: 'Báo cáo nhanh', desc: 'Tóm tắt, tiến độ, vướng mắc, số liệu.', kind: 'note', icon: 'chart',
      title: `Báo cáo nhanh ${d}`,
      content: `## Tóm tắt\n> Một câu: tình hình đang thế nào?\n\n## Đã hoàn thành\n- \n\n## Đang làm\n- \n\n## Vướng mắc / cần hỗ trợ\n- \n\n## Số liệu chính\n| Chỉ số | Kỳ này | Kỳ trước |\n|---|---|---|\n|  |  |  |\n\n## Bước tiếp theo\n- [ ] \n`,
    },
    {
      id: 'client', label: 'Ghi chú khách hàng', desc: 'Liên hệ, nhu cầu, đề xuất, theo dõi.', kind: 'meeting', icon: 'mail',
      title: 'Khách hàng: ',
      content: `**Công ty:** \n**Người liên hệ:** \n**Điện thoại / Email:** \n**Ngày gặp:** ${d}\n\n## Nhu cầu\n- \n\n## Trao đổi chính\n- \n\n## Đề xuất / báo giá\n- \n\n## Theo dõi\n- [ ] Gửi email tóm tắt & cảm ơn\n- [ ] Hẹn lịch tiếp theo\n`,
    },
  ];
}

/** Outline of a template (its headings) for the picker preview. */
export function templateOutline(content) {
  return [...String(content).matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1]).slice(0, 4);
}

/* =====================================================================
   5. Popover (anchored panel with arbitrary content)
   ===================================================================== */

let openPop = null;
export function closePopover() {
  openPop?.close();
}

/**
 * openPopover(anchor, tpl, { onOpen(el, close), label }) → { el, close }
 * Closes on outside pointerdown, Escape, route change and resize.
 */
export function openPopover(anchor, tpl, { onOpen, label = '', className = '' } = {}) {
  closePopover();
  const el = document.createElement('div');
  el.className = `nb-pop ${className}`;
  el.setAttribute('role', 'dialog');
  if (label) el.setAttribute('aria-label', label);
  el.innerHTML = String(tpl);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  Object.assign(el.style, { left: Math.max(8, left) + 'px', top: top + 'px' });

  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  const close = () => {
    if (openPop?.el !== el) return;
    openPop = null;
    el.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('hashchange', close);
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  window.addEventListener('hashchange', close);
  openPop = { el, close };
  onOpen?.(el, close);
  return openPop;
}

/** Extra toolbar glyphs (same 24px / 1.6 stroke style as icons.js). */
const SVG = {
  clear: '<path d="M6 5h12M12 5l-3 14"/><path d="m15 14 5 5M20 14l-5 5"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M14.5 9.5v10"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-4.5-4.5-8.5 8"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
};
const svg = (name) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name]}</svg>`);

/** Block styles of the "Kiểu chữ" menu: id → editor exec command. */
export const BLOCK_STYLES = [
  { id: 'p', label: 'Đoạn văn', keys: 'Ctrl+Alt+0' },
  { id: 'h1', label: 'Tiêu đề 1', keys: 'Ctrl+Alt+1' },
  { id: 'h2', label: 'Tiêu đề 2', keys: 'Ctrl+Alt+2' },
  { id: 'h3', label: 'Tiêu đề 3', keys: 'Ctrl+Alt+3' },
  { id: 'quote', label: 'Trích dẫn' },
  { id: 'code', label: 'Khối mã' },
];

/**
 * Toolbar of the rich editor (also drives the Markdown textarea in source mode).
 * - `toggle`: carries aria-pressed (painted from the editor's activeState)
 * - `menu`: opens a menu / popover
 * - `prio`: 1 = stays visible longest; when the row runs out of space the page moves
 *   tools into the "⋯ Thêm" menu, highest prio number first (priority+ pattern)
 * - `only: 'desk' | 'phone'`: the "Kiểu chữ" menu on wide screens, H1–H3 / quote
 *   buttons in the phone's scrolling bar.
 */
export const TOOLS = [
  { id: 'block', label: 'Kiểu chữ', menu: true, prio: 1, only: 'desk' },
  { id: 'h1', glyph: 'H1', label: 'Tiêu đề 1', keys: 'Ctrl+Alt+1', toggle: true, only: 'phone' },
  { id: 'h2', glyph: 'H2', label: 'Tiêu đề 2', keys: 'Ctrl+Alt+2', toggle: true, only: 'phone' },
  { id: 'h3', glyph: 'H3', label: 'Tiêu đề 3', keys: 'Ctrl+Alt+3', toggle: true, only: 'phone' },
  'sep',
  { id: 'bold', glyph: 'B', label: 'Đậm', keys: 'Ctrl+B', cls: 'is-bold', toggle: true, prio: 1 },
  { id: 'italic', glyph: 'I', label: 'Nghiêng', keys: 'Ctrl+I', cls: 'is-italic', toggle: true, prio: 1 },
  { id: 'underline', glyph: 'U', label: 'Gạch chân', keys: 'Ctrl+U', cls: 'is-underline', toggle: true, prio: 2 },
  { id: 'strike', glyph: 'S', label: 'Gạch ngang', keys: 'Ctrl+Shift+X', cls: 'is-strike', toggle: true, prio: 4 },
  { id: 'mark', glyph: 'A', label: 'Tô sáng', keys: 'Ctrl+Shift+H', cls: 'is-mark', toggle: true, prio: 3 },
  'sep',
  { id: 'ul', icon: 'list', label: 'Danh sách', keys: 'Ctrl+Shift+8', toggle: true, prio: 2 },
  { id: 'ol', glyph: '1.', label: 'Danh sách số', keys: 'Ctrl+Shift+7', toggle: true, prio: 3 },
  { id: 'task', icon: 'checkSquare', label: 'Việc cần làm', keys: 'Ctrl+Shift+9', toggle: true, prio: 1 },
  { id: 'quote', glyph: '“', label: 'Trích dẫn', cls: 'is-quote', toggle: true, only: 'phone' },
  'sep',
  { id: 'link', icon: 'link', label: 'Liên kết', keys: 'Ctrl+K', toggle: true, menu: true, prio: 3 },
  { id: 'image', svg: 'image', label: 'Chèn ảnh', prio: 2 },
  { id: 'record', svg: 'mic', label: 'Ghi âm cuộc họp', prio: 3 },
  'sep',
  { id: 'undo', icon: 'undo', label: 'Hoàn tác', keys: 'Ctrl+Z', prio: 2 },
  { id: 'redo', svg: 'redo', label: 'Làm lại', keys: 'Ctrl+Y', prio: 4 },
  'sep',
  // Secondary: first to move into "⋯ Thêm" when space runs out.
  { id: 'case', glyph: 'Aa', label: 'Đổi kiểu chữ hoa / thường', keys: 'Ctrl+Shift+U', cls: 'is-case', menu: true, prio: 8 },
  { id: 'clear', svg: 'clear', label: 'Xóa định dạng', keys: 'Ctrl+\\', prio: 8 },
  { id: 'code', glyph: '</>', label: 'Mã', keys: 'Ctrl+E', toggle: true, prio: 8 },
  { id: 'table', svg: 'table', label: 'Bảng', prio: 8 },
  { id: 'hr', glyph: '—', label: 'Đường kẻ', prio: 9 },
  { id: 'find', icon: 'search', label: 'Tìm và thay thế', keys: 'Ctrl+F · Ctrl+H', prio: 7 },
  { id: 'line-task', icon: 'tasks', label: 'Tạo công việc từ dòng này', text: 'Việc', prio: 7 },
  { id: 'more', icon: 'more', label: 'Thêm công cụ', menu: true, only: 'desk' },
];

function toolGlyph(t) {
  if (t.id === 'block') {
    return html`<span class="nb-tool__block" data-block-label>${BLOCK_STYLES[0].label}</span>${icon('chevronDown')}`;
  }
  return t.icon ? icon(t.icon) : t.svg ? svg(t.svg) : html`<span aria-hidden="true">${t.glyph}</span>`;
}

/** Buttons for a role="toolbar" container: one tab stop (roving tabindex). */
export function toolbarTpl() {
  let first = true;
  return html`${TOOLS.map((t) => {
    if (t === 'sep') return html`<span class="nb-tools__sep" aria-hidden="true"></span>`;
    const tab = first ? '0' : '-1';
    first = false;
    const cls = [
      'nb-tool', t.cls || '', t.text ? 'nb-tool--text' : '', t.only ? `nb-tool--${t.only}` : '',
      t.id === 'block' ? 'nb-tool--block' : '', t.id === 'more' ? 'nb-tool--more' : '',
    ].filter(Boolean).join(' ');
    const popup = t.menu ? raw(` aria-haspopup="${t.id === 'link' ? 'dialog' : 'menu'}"${t.id === 'more' || t.id === 'block' || t.id === 'case' ? ' aria-expanded="false"' : ''}`) : '';
    const keys = t.keys ? raw(` aria-keyshortcuts="${t.keys.split(' · ')[0].replace('Ctrl', 'Control')}"`) : '';
    return html`<button type="button" class="${cls}" data-tool="${t.id}" data-prio="${t.prio || 0}" tabindex="${tab}" title="${t.label}${t.keys ? ` (${t.keys})` : ''}" aria-label="${t.label}"${t.toggle ? raw(' aria-pressed="false"') : ''}${popup}${keys}${t.id === 'more' ? raw(' hidden') : ''}>${toolGlyph(t)}${t.text ? html`<span>${t.text}</span>` : ''}</button>`;
  })}`;
}
