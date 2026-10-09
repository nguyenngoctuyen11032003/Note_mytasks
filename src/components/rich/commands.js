// Rich editor formatting commands (stream A2).
//
// Pure DOM operations on an editor root (the contenteditable element whose DOM
// follows docs/rich-editor-design.md) and the current window Selection. No
// document.execCommand: every command reads the affected text blocks into a flat
// "inline model" (text segments + atoms, each with a set of marks), edits the
// model and re-renders it canonically. That guarantees:
//   - no nested duplicate marks (<strong><strong>), no empty marks,
//   - marks never wrap block elements,
//   - adjacent identical marks are merged,
//   - the selection is restored on the same text (via text offsets).
//
// Text positions: every text block (p, h1-h6, pre, li, td, th, div) has a length
// = text characters + 1 per atom (<br>, non-editable inline element); a <br> that
// is the LAST leaf of its block is a placeholder and counts 0. A "global offset"
// joins blocks with one separator character, so block-structure commands
// (p <-> h1 <-> li <-> pre) keep the selection stable. saveSelection /
// restoreSelection expose that model (used by the editor for undo snapshots).

/* =====================================================================
   Constants
   ===================================================================== */

export const MARKS = ['bold', 'italic', 'underline', 'strike', 'mark', 'code'];
const MARK_TAG = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', mark: 'mark', code: 'code' };
const TAG_MARK = {
  STRONG: 'bold', B: 'bold', EM: 'italic', I: 'italic', U: 'underline', INS: 'underline',
  S: 'strike', DEL: 'strike', STRIKE: 'strike', MARK: 'mark', CODE: 'code',
};
const RANK = { link: 0, bold: 1, italic: 2, underline: 3, strike: 4, mark: 5, code: 6 };
const LIST = new Set(['UL', 'OL']);
const CONTAINER = new Set(['BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'SECTION', 'ARTICLE']);
const BLOCK_CHILD = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TABLE', 'DIV', 'FIGURE', 'HR']);
const VOID_ATOM = new Set(['IMG', 'INPUT', 'AUDIO', 'VIDEO', 'IFRAME', 'SVG', 'CANVAS', 'OBJECT', 'EMBED', 'FIGURE', 'HR', 'BUTTON', 'SELECT', 'TEXTAREA']);
const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'quote', 'code'];
const LIST_TYPES = ['ul', 'ol', 'task'];
const NO_MARKS = Object.freeze({});
const OBJ = '￼';

/** Class of the task-item checkbox (UI only, contenteditable=false). */
export const CHECKBOX_CLASS = 'rt-check';

/* =====================================================================
   Small DOM helpers
   ===================================================================== */

const isEl = (n) => n && n.nodeType === 1;
const isText = (n) => n && n.nodeType === 3;
const tagOf = (n) => (isEl(n) ? n.tagName.toUpperCase() : '');
const isNonEditable = (n) => isEl(n) && n.getAttribute('contenteditable') === 'false';
const indexOf = (n) => Array.prototype.indexOf.call(n.parentNode.childNodes, n);
const docOf = (root) => root.ownerDocument || document;

function isCheckbox(n) {
  if (!isEl(n)) return false;
  if (tagOf(n) === 'INPUT' && n.getAttribute('type') === 'checkbox') return true;
  return isNonEditable(n) || (n.classList && n.classList.contains(CHECKBOX_CLASS));
}

/** The task checkbox element inserted at the start of a task item. */
export function makeCheckbox(doc, checked = false) {
  const el = doc.createElement('span');
  el.className = CHECKBOX_CLASS;
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('role', 'checkbox');
  el.setAttribute('aria-checked', checked ? 'true' : 'false');
  return el;
}

function retag(el, tag) {
  if (tagOf(el) === tag.toUpperCase()) return el;
  const n = docOf(el).createElement(tag);
  while (el.firstChild) n.appendChild(el.firstChild);
  el.parentNode.replaceChild(n, el);
  return n;
}

/* =====================================================================
   Text blocks
   ===================================================================== */

function hasBlockChild(el) {
  for (const c of el.children) if (BLOCK_CHILD.has(tagOf(c))) return true;
  return false;
}

function collectBlocks(el, out) {
  for (const c of el.children) {
    const t = tagOf(c);
    if (isNonEditable(c)) continue;
    if (t === 'P' || t === 'PRE' || /^H[1-6]$/.test(t)) out.push(c);
    else if (t === 'LI' || t === 'TD' || t === 'TH' || t === 'DIV') {
      if (hasBlockChild(c)) collectBlocks(c, out);
      else {
        out.push(c);
        for (const l of c.children) if (LIST.has(tagOf(l))) collectBlocks(l, out);
      }
    } else if (CONTAINER.has(t)) collectBlocks(c, out);
  }
  return out;
}

/** All editable text blocks of the root, in document order. */
export function textBlocks(root) {
  return collectBlocks(root, []);
}

/** Wraps stray inline content sitting directly in the root into <p>. */
function normalizeRoot(root) {
  let run = [];
  const flush = () => {
    if (run.some((n) => (isText(n) ? n.data.trim() : true))) {
      const p = docOf(root).createElement('p');
      run[0].parentNode.insertBefore(p, run[0]);
      for (const n of run) p.appendChild(n);
    }
    run = [];
  };
  for (const n of [...root.childNodes]) {
    const inline = isText(n) || (isEl(n) && !BLOCK_CHILD.has(tagOf(n)) && !CONTAINER.has(tagOf(n)) && tagOf(n) !== 'LI' && !isNonEditable(n));
    if (inline && !(isEl(n) && tagOf(n) === 'BR' && !run.length)) run.push(n);
    else flush();
  }
  flush();
}

/* =====================================================================
   Inline model
   ===================================================================== */

function attrsOf(el) {
  const o = {};
  for (const a of el.attributes) if (a.name !== 'href') o[a.name] = a.value;
  return o;
}

function flatten(n, marks, out, inPre) {
  if (isText(n)) {
    if (n.data) out.push({ node: n, text: n.data, marks });
    return;
  }
  if (!isEl(n)) return;
  const t = tagOf(n);
  if (t === 'BR') { out.push({ node: n, atom: true, br: true, marks: NO_MARKS }); return; }
  if (isNonEditable(n) || VOID_ATOM.has(t)) { out.push({ node: n, atom: true, marks: NO_MARKS }); return; }
  let m = marks;
  const key = TAG_MARK[t];
  if (key && !inPre) { if (!marks[key]) m = { ...marks, [key]: true }; }
  else if (t === 'A' && n.getAttribute('href') && !inPre) m = { ...marks, link: { href: n.getAttribute('href'), attrs: attrsOf(n) } };
  for (const c of [...n.childNodes]) flatten(c, m, out, inPre);
}

function measure(segs) {
  let pos = 0;
  segs.forEach((s, i) => {
    s.start = pos;
    s.len = s.atom ? (s.br && i === segs.length - 1 ? 0 : 1) : s.text.length;
    pos += s.len;
    s.end = pos;
  });
  return pos;
}

function readInline(block) {
  const prefix = []; const inline = []; const tail = [];
  const isLi = tagOf(block) === 'LI';
  for (const n of [...block.childNodes]) {
    if (isEl(n) && LIST.has(tagOf(n))) { tail.push(n); continue; }
    if (isLi && !inline.length && !tail.length && isCheckbox(n)) { prefix.push(n); continue; }
    inline.push(n);
  }
  const segs = [];
  const inPre = tagOf(block) === 'PRE';
  for (const n of inline) flatten(n, NO_MARKS, segs, inPre);
  const length = measure(segs);
  return { block, prefix, inline, tail, segs, length };
}

const blockLen = (b) => readInline(b).length;

function segString(s) {
  if (!s.atom) return s.text;
  if (s.br) return s.len ? '\n' : '';
  return OBJ;
}
const modelString = (m) => m.segs.map(segString).join('');

function sameLink(a, b) {
  return (a ? a.href : null) === (b ? b.href : null);
}
function sameMarks(a, b) {
  for (const k of MARKS) if (!!a[k] !== !!b[k]) return false;
  return sameLink(a.link, b.link);
}
const markKeys = (m) => [...(m.link ? ['link'] : []), ...MARKS.filter((k) => m[k])];

/** Splits the text segment straddling `off` so a boundary exists there. */
function splitAt(segs, off) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s.atom && s.start < off && off < s.end) {
      const k = off - s.start;
      const a = { text: s.text.slice(0, k), marks: s.marks, start: s.start, len: k, end: off };
      const b = { text: s.text.slice(k), marks: s.marks, start: off, len: s.end - off, end: s.end };
      segs.splice(i, 1, a, b);
      return;
    }
  }
}

const textSegsIn = (segs, s, e) => segs.filter((x) => !x.atom && x.len > 0 && x.start >= s && x.end <= e);

function runLength(list, i, i1, k, ref, open) {
  let n = 0;
  for (let j = i; j < i1; j++) {
    const m = list[j];
    if (m.atom) break;
    if (k === 'link' ? !(m.marks.link && m.marks.link.href === ref.link.href) : !m.marks[k]) break;
    if (k === 'code' && markKeys(m.marks).some((x) => x !== 'code' && !open.has(x))) break;
    n++;
  }
  return n;
}

function makeMarkEl(doc, k, marks) {
  if (k === 'link') {
    const a = doc.createElement('a');
    for (const [n, v] of Object.entries(marks.link.attrs || {})) a.setAttribute(n, v);
    a.setAttribute('href', marks.link.href);
    return a;
  }
  return doc.createElement(MARK_TAG[k]);
}

function build(doc, list, i0, i1, parent, open) {
  let i = i0;
  while (i < i1) {
    const s = list[i];
    const keys = s.atom ? [] : markKeys(s.marks).filter((k) => !open.has(k));
    if (!keys.length) {
      parent.appendChild(s.atom ? s.node : doc.createTextNode(s.text));
      i++;
      continue;
    }
    let best = null; let bestLen = -1;
    for (const k of keys) {
      const len = runLength(list, i, i1, k, s.marks, open);
      if (len > bestLen || (len === bestLen && RANK[k] < RANK[best])) { best = k; bestLen = len; }
    }
    const el = makeMarkEl(doc, best, s.marks);
    build(doc, list, i, i + bestLen, el, new Set([...open, best]));
    parent.appendChild(el);
    i += bestLen;
  }
}

function render(doc, segs) {
  const list = [];
  for (const s of segs) {
    const last = list[list.length - 1];
    if (s.atom) list.push(s);
    else if (!s.text) continue;
    else if (last && !last.atom && sameMarks(last.marks, s.marks)) last.text += s.text;
    else list.push({ text: s.text, marks: s.marks });
  }
  const frag = doc.createDocumentFragment();
  build(doc, list, 0, list.length, frag, new Set());
  return frag;
}

function writeInline(model, segs = model.segs) {
  const { block, inline, tail } = model;
  // a placeholder <br> is not needed any more once text precedes it
  const n = segs.length;
  if (n > 1 && segs[n - 1].br && !segs[n - 2].atom) segs = segs.slice(0, -1);
  for (const n of inline) if (n.parentNode === block) block.removeChild(n);
  const doc = docOf(block);
  const frag = render(doc, segs);
  if (!frag.childNodes.length) frag.appendChild(doc.createElement('br'));
  const ref = tail.find((t) => t.parentNode === block) || null;
  block.insertBefore(frag, ref);
}

function ensurePlaceholder(block) {
  const m = readInline(block);
  if (!m.segs.length) {
    const ref = m.tail.find((t) => t.parentNode === block) || null;
    block.insertBefore(docOf(block).createElement('br'), ref);
  }
}

/* =====================================================================
   Points, selection and offsets
   ===================================================================== */

function pathOf(root, node) {
  const p = [];
  while (node && node !== root) {
    const par = node.parentNode;
    if (!par) return null;
    p.push(indexOf(node));
    node = par;
  }
  return node === root ? p.reverse() : null;
}

function cmpPoint(root, a, b) {
  const pa = [...(pathOf(root, a.node) || []), a.offset];
  const pb = [...(pathOf(root, b.node) || []), b.offset];
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}

function offsetInBlock(root, model, node, offset) {
  if (isText(node)) {
    const s = model.segs.find((x) => x.node === node);
    if (s) return s.start + Math.min(offset, s.len);
  }
  const P = { node, offset };
  for (const s of model.segs) {
    if (!s.node || !s.node.parentNode) continue;
    if (cmpPoint(root, { node: s.node.parentNode, offset: indexOf(s.node) }, P) >= 0) return s.start;
  }
  return model.length;
}

function locate(root, blocks, index, node, offset, bias) {
  let n = node;
  while (n && n !== root) {
    if (index.has(n)) {
      return { i: index.get(n), off: offsetInBlock(root, readInline(n), node, offset) };
    }
    if (isEl(n) && (CONTAINER.has(tagOf(n)) || isNonEditable(n))) break;
    n = n.parentNode;
  }
  const P = { node, offset };
  if (bias === 'start') {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (cmpPoint(root, { node: b, offset: b.childNodes.length }, P) >= 0) {
        return { i, off: cmpPoint(root, { node: b, offset: 0 }, P) >= 0 ? 0 : blockLen(b) };
      }
    }
    return { i: blocks.length - 1, off: blockLen(blocks[blocks.length - 1]) };
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (cmpPoint(root, { node: b, offset: 0 }, P) <= 0) {
      return { i, off: cmpPoint(root, { node: b, offset: b.childNodes.length }, P) <= 0 ? blockLen(b) : 0 };
    }
  }
  return { i: 0, off: 0 };
}

/** DOM point for a block offset. bias 'start' prefers the following text, 'end' the preceding. */
function pointAt(block, off, bias = 'start') {
  const m = readInline(block);
  const segs = m.segs;
  if (!segs.length) return { node: block, offset: m.prefix.length };
  off = Math.max(0, Math.min(off, m.length));
  const before = (s) => ({ node: s.node.parentNode, offset: indexOf(s.node) });
  const after = (s) => ({ node: s.node.parentNode, offset: indexOf(s.node) + 1 });
  if (bias === 'start') {
    for (const s of segs) if (!s.atom && s.start <= off && off < s.end) return { node: s.node, offset: off - s.start };
    for (const s of segs) if (s.atom && s.start === off) return before(s);
    for (const s of segs) if (!s.atom && s.end === off) return { node: s.node, offset: s.len };
    for (const s of segs) if (s.atom && s.end === off) return after(s);
  } else {
    for (const s of segs) if (!s.atom && s.start < off && off <= s.end) return { node: s.node, offset: off - s.start };
    for (const s of segs) if (!s.atom && s.start === off) return { node: s.node, offset: 0 };
    for (const s of segs) if (s.atom && s.end === off && s.len) return after(s);
    for (const s of segs) if (s.atom && s.start === off) return before(s);
  }
  return after(segs[segs.length - 1]);
}

function getSelectionObj(root) {
  const doc = docOf(root);
  if (doc.getSelection) return doc.getSelection();
  const win = doc.defaultView || globalThis;
  return win.getSelection ? win.getSelection() : null;
}

function getRange(root) {
  const sel = getSelectionObj(root);
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const inRoot = (n) => n === root || root.contains(n);
  if (!inRoot(r.startContainer) || !inRoot(r.endContainer)) return null;
  return r;
}

function setRange(root, a, b) {
  const sel = getSelectionObj(root);
  if (!sel) return;
  const r = docOf(root).createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(r);
}

function ctx(root) {
  if (!root) return null;
  const r = getRange(root);
  if (!r) return null;
  normalizeRoot(root);
  const blocks = textBlocks(root);
  if (!blocks.length) return null;
  const index = new Map(blocks.map((b, i) => [b, i]));
  const a = locate(root, blocks, index, r.startContainer, r.startOffset, 'start');
  let b = r.collapsed ? a : locate(root, blocks, index, r.endContainer, r.endOffset, 'end');
  if (b.i < a.i || (b.i === a.i && b.off < a.off)) b = a;
  const lens = blocks.map(blockLen);
  // a non-collapsed range that holds no text (e.g. only a figure) is not a caret
  const collapsed = r.collapsed;
  return { root, range: r, blocks, index, a, b, lens, collapsed };
}

function globalOf(c, p) {
  let g = 0;
  for (let i = 0; i < p.i; i++) g += c.lens[i] + 1;
  return g + p.off;
}

/** Parts of the selection per block: [{ block, s, e }]. blockMode drops a trailing block selected only at offset 0. */
function touched(c, blockMode = false) {
  const out = [];
  let last = c.b.i;
  if (blockMode && !c.collapsed && c.b.i > c.a.i && c.b.off === 0) last--;
  for (let i = c.a.i; i <= last; i++) {
    out.push({ block: c.blocks[i], s: i === c.a.i ? c.a.off : 0, e: i === c.b.i ? c.b.off : c.lens[i] });
  }
  return out;
}

/** Selection as global text offsets { start, end }, or null when it is not inside root. */
export function saveSelection(root) {
  const c = ctx(root);
  if (!c) return null;
  return { start: globalOf(c, c.a), end: globalOf(c, c.b) };
}

function toBlockPos(blocks, g) {
  for (let i = 0; i < blocks.length; i++) {
    const len = blockLen(blocks[i]);
    if (g <= len) return { i, off: Math.max(0, g) };
    g -= len + 1;
  }
  const i = blocks.length - 1;
  return { i, off: blockLen(blocks[i]) };
}

/** Restores a selection saved by saveSelection (clamped to the document). */
export function restoreSelection(root, saved, caretBias = 'start') {
  if (!saved) return false;
  const blocks = textBlocks(root);
  if (!blocks.length) return false;
  const a = toBlockPos(blocks, saved.start);
  const pa = pointAt(blocks[a.i], a.off, saved.end === saved.start ? caretBias : 'start');
  if (saved.end === saved.start) { setRange(root, pa, pa); return true; }
  const b = toBlockPos(blocks, saved.end);
  setRange(root, pa, pointAt(blocks[b.i], b.off, 'end'));
  return true;
}

function placeCaret(root, block, off = 0) {
  const p = pointAt(block, off, 'start');
  setRange(root, p, p);
}

/* =====================================================================
   Pending marks (collapsed caret)
   ===================================================================== */

const pendingStore = new WeakMap();

function caretMarks(model, off) {
  const segs = model.segs;
  let prev = null; let next = null;
  for (const s of segs) {
    if (s.atom || !s.len) continue;
    if (s.start < off && off <= s.end) prev = s;
    if (!next && s.start <= off && off < s.end) next = s;
  }
  const seg = prev || next;
  if (!seg) return {};
  const m = { ...seg.marks };
  // typing at the end of a link does not extend it
  if (prev && m.link && off === prev.end) {
    const after = segs.find((s) => !s.atom && s.len && s.start === off);
    if (!after || !sameLink(after.marks.link, m.link)) delete m.link;
  }
  return m;
}

function validPending(root, c) {
  const p = pendingStore.get(root);
  if (!p) return null;
  if (!c || !c.collapsed || globalOf(c, c.a) !== p.g || c.blocks[c.a.i] !== p.block) {
    pendingStore.delete(root);
    return null;
  }
  return p;
}

/** Pending marks for the next typed text: { bold: true, italic: false, … } ({} when none or the caret moved). */
export function getPendingMarks(root) {
  const p = validPending(root, ctx(root));
  return p ? { ...p.marks } : {};
}

export function clearPendingMarks(root) {
  pendingStore.delete(root);
}

function applyMarkSet(marks, key, on) {
  const m = { ...marks };
  if (on) {
    m[key] = true;
    if (key === 'code') for (const k of MARKS) if (k !== 'code') delete m[k];
  } else delete m[key];
  return m;
}

function effectiveMarks(base, pending) {
  let m = { ...base };
  for (const [k, v] of Object.entries(pending || {})) m = applyMarkSet(m, k, v);
  return m;
}

/* =====================================================================
   Marks
   ===================================================================== */

/**
 * Toggles an inline mark. Selection fully marked -> unwrap, otherwise wrap all.
 * Collapsed caret -> toggles a pending mark and returns { pending } (applied by insertText).
 * Returns true when the DOM changed.
 */
export function toggleMark(root, mark) {
  if (!MARKS.includes(mark)) return false;
  const c = ctx(root);
  if (!c) return false;
  if (c.collapsed) {
    const block = c.blocks[c.a.i];
    if (tagOf(block) === 'PRE') return false;
    const cur = caretMarks(readInline(block), c.a.off);
    const p = validPending(root, c) || { marks: {}, g: globalOf(c, c.a), block };
    const curEff = mark in p.marks ? p.marks[mark] : !!cur[mark];
    const next = !curEff;
    if (next === !!cur[mark]) delete p.marks[mark];
    else p.marks[mark] = next;
    pendingStore.set(root, p);
    return { pending: { ...p.marks } };
  }
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  const models = [];
  const sel = [];
  for (const t of touched(c)) {
    if (tagOf(t.block) === 'PRE') continue;
    const m = readInline(t.block);
    splitAt(m.segs, t.s); splitAt(m.segs, t.e);
    const segs = textSegsIn(m.segs, t.s, t.e);
    if (!segs.length) continue;
    models.push(m); sel.push(...segs);
  }
  if (!sel.length) return false;
  const all = sel.every((s) => !!s.marks[mark]);
  for (const s of sel) s.marks = applyMarkSet(s.marks, mark, !all);
  models.forEach((m) => writeInline(m));
  clearPendingMarks(root);
  restoreSelection(root, saved);
  return true;
}

/**
 * Inserts plain text at the caret (replacing a selection inside one block), applying
 * the caret's marks and any pending marks. Returns true when inserted.
 */
export function insertText(root, text) {
  const c = ctx(root);
  if (!c || c.a.i !== c.b.i) return false;
  text = String(text ?? '');
  const block = c.blocks[c.a.i];
  const p = validPending(root, c);
  const g = globalOf(c, c.a);
  if (tagOf(block) === 'PRE') {
    const str = modelString(readInline(block));
    setPreText(block, str.slice(0, c.a.off) + text + str.slice(c.b.off));
  } else {
    const m = readInline(block);
    const marks = effectiveMarks(caretMarks(m, c.a.off), p && p.marks);
    replaceInSegs(m.segs, c.a.off, c.b.off, text, marks);
    writeInline(m);
  }
  clearPendingMarks(root);
  // caret stays inside the inserted text so native typing keeps its marks
  restoreSelection(root, { start: g + text.length, end: g + text.length }, 'end');
  return true;
}

/* =====================================================================
   Block helpers
   ===================================================================== */

function blockKind(b) {
  const t = tagOf(b);
  if (t === 'PRE') return 'code';
  if (t === 'LI') return 'li';
  if (t === 'TD' || t === 'TH') return 'cell';
  if (/^H[1-6]$/.test(t)) return t === 'H1' ? 'h1' : t === 'H2' ? 'h2' : 'h3';
  if (tagOf(b.parentNode) === 'BLOCKQUOTE') return 'quote';
  return 'p';
}

function listTypeOf(list) {
  if (tagOf(list) === 'OL') return 'ol';
  return list.getAttribute('data-type') === 'task' ? 'task' : 'ul';
}

function listKind(root, b) {
  let n = b;
  while (n && n !== root) {
    if (tagOf(n) === 'LI' && LIST.has(tagOf(n.parentNode))) return listTypeOf(n.parentNode);
    n = n.parentNode;
  }
  return null;
}

function makeList(doc, type) {
  const l = doc.createElement(type === 'ol' ? 'ol' : 'ul');
  if (type === 'task') l.setAttribute('data-type', 'task');
  return l;
}

function cloneList(list) {
  const l = docOf(list).createElement(tagOf(list).toLowerCase());
  for (const a of list.attributes) l.setAttribute(a.name, a.value);
  return l;
}

function conformItem(li, type) {
  const doc = docOf(li);
  const boxes = [];
  for (const n of li.childNodes) { if (isCheckbox(n)) boxes.push(n); else if (!(isText(n) && !n.data)) break; }
  if (type === 'task') {
    if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
    if (!boxes.length) li.insertBefore(makeCheckbox(doc, li.getAttribute('data-checked') === 'true'), li.firstChild);
  } else {
    boxes.forEach((b) => b.remove());
    li.removeAttribute('data-checked');
  }
}

function switchList(list, type) {
  if (listTypeOf(list) === type) return list;
  const nl = docOf(list).createElement(type === 'ol' ? 'ol' : 'ul');
  for (const a of list.attributes) if (a.name !== 'data-type' && a.name !== 'start') nl.setAttribute(a.name, a.value);
  if (type === 'task') nl.setAttribute('data-type', 'task');
  while (list.firstChild) nl.appendChild(list.firstChild);
  list.parentNode.replaceChild(nl, list);
  for (const li of nl.children) if (tagOf(li) === 'LI') conformItem(li, type);
  return nl;
}

const sameListType = (a, b) => isEl(a) && isEl(b) && LIST.has(tagOf(a)) && LIST.has(tagOf(b)) && listTypeOf(a) === listTypeOf(b);

function mergeWithNext(list) {
  if (!list || !list.parentNode) return;
  let next = list.nextElementSibling;
  while (next && sameListType(list, next)) {
    while (next.firstChild) list.appendChild(next.firstChild);
    next.remove();
    next = list.nextElementSibling;
  }
}

function mergeAround(list) {
  if (!list || !list.parentNode) return;
  const prev = list.previousElementSibling;
  if (sameListType(prev, list)) { mergeWithNext(prev); return; }
  mergeWithNext(list);
}

const liItems = (list) => [...list.children].filter((c) => tagOf(c) === 'LI');

/** Moves a nested item one level up (following siblings become its children). */
function outdentItem(li) {
  const list = li.parentNode;
  const parentLi = list.parentNode;
  const following = [];
  for (let n = li.nextSibling; n; n = n.nextSibling) following.push(n);
  if (following.some((n) => tagOf(n) === 'LI')) {
    const sub = cloneList(list);
    following.forEach((n) => sub.appendChild(n));
    li.appendChild(sub);
  }
  parentLi.parentNode.insertBefore(li, parentLi.nextSibling);
  if (!liItems(list).length) list.remove();
  conformItem(li, listTypeOf(li.parentNode));
  mergeAdjacentChildLists(li);
}

function mergeAdjacentChildLists(li) {
  for (const c of [...li.children]) if (LIST.has(tagOf(c)) && c.parentNode) mergeWithNext(c);
}

/** Turns a top-level list item into a paragraph, splitting its list. */
function liftItem(li) {
  const doc = docOf(li);
  const list = li.parentNode;
  const m = readInline(li);
  const p = doc.createElement('p');
  for (const n of m.inline) p.appendChild(n);
  ensurePlaceholder(p);
  const nested = m.tail;
  const after = [];
  for (let n = li.nextSibling; n; n = n.nextSibling) after.push(n);
  let l2 = null;
  if (after.some((n) => tagOf(n) === 'LI')) {
    l2 = cloneList(list);
    after.forEach((n) => l2.appendChild(n));
  }
  const parent = list.parentNode;
  let ref = list.nextSibling;
  parent.insertBefore(p, ref);
  for (const n of nested) parent.insertBefore(n, ref);
  if (l2) parent.insertBefore(l2, ref);
  li.remove();
  if (!liItems(list).length) list.remove();
  if (nested.length) mergeWithNext(nested[nested.length - 1]);
  return p;
}

function isNestedItem(li) {
  return tagOf(li.parentNode && li.parentNode.parentNode) === 'LI';
}

function liftToTop(li) {
  while (isNestedItem(li)) outdentItem(li);
  return liftItem(li);
}

function unquote(block) {
  const bq = block.parentNode;
  if (tagOf(bq) !== 'BLOCKQUOTE') return block;
  const after = [];
  for (let n = block.nextSibling; n; n = n.nextSibling) after.push(n);
  bq.parentNode.insertBefore(block, bq.nextSibling);
  if (after.some((n) => isEl(n))) {
    const bq2 = docOf(bq).createElement('blockquote');
    after.forEach((n) => bq2.appendChild(n));
    block.parentNode.insertBefore(bq2, block.nextSibling);
  }
  if (![...bq.childNodes].some((n) => isEl(n) || (isText(n) && n.data.trim()))) bq.remove();
  return block;
}

function quoteWrap(block) {
  if (tagOf(block.parentNode) === 'BLOCKQUOTE') return block;
  const doc = docOf(block);
  let bq = doc.createElement('blockquote');
  block.parentNode.insertBefore(bq, block);
  bq.appendChild(block);
  const prev = bq.previousElementSibling;
  if (tagOf(prev) === 'BLOCKQUOTE') {
    while (bq.firstChild) prev.appendChild(bq.firstChild);
    bq.remove();
    bq = prev;
  }
  const next = bq.nextElementSibling;
  if (tagOf(next) === 'BLOCKQUOTE') {
    while (next.firstChild) bq.appendChild(next.firstChild);
    next.remove();
  }
  return block;
}

function preText(pre) {
  let s = modelString(readInline(pre));
  if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}

function setPreText(pre, text) {
  let code = null;
  for (const c of pre.children) if (tagOf(c) === 'CODE') { code = c; break; }
  if (!code) {
    code = docOf(pre).createElement('code');
    pre.textContent = '';
    pre.appendChild(code);
  }
  code.textContent = text;
  if (!text) code.appendChild(docOf(pre).createElement('br'));
}

function makePre(doc, text, lang) {
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  if (lang) code.setAttribute('data-lang', lang);
  pre.appendChild(code);
  setPreText(pre, text);
  return pre;
}

/** Splits a code block into one block per line ('p'|'h1'|…|'quote'). */
function preToBlocks(pre, target) {
  const doc = docOf(pre);
  const lines = preText(pre).split('\n');
  const tag = target === 'quote' || target === 'p' ? 'p' : target;
  const els = lines.map((line) => {
    const el = doc.createElement(tag);
    if (line) el.appendChild(doc.createTextNode(line));
    else el.appendChild(doc.createElement('br'));
    return el;
  });
  const parent = pre.parentNode;
  if (target === 'quote') {
    const bq = doc.createElement('blockquote');
    els.forEach((e) => bq.appendChild(e));
    parent.insertBefore(bq, pre);
    pre.remove();
    quoteWrap(els[0]);
    if (tagOf(bq.nextElementSibling) === 'BLOCKQUOTE') {
      const n = bq.nextElementSibling;
      while (n.firstChild) bq.appendChild(n.firstChild);
      n.remove();
    }
    const prev = bq.previousElementSibling;
    if (tagOf(prev) === 'BLOCKQUOTE' && bq.parentNode) {
      while (bq.firstChild) prev.appendChild(bq.firstChild);
      bq.remove();
    }
  } else {
    els.forEach((e) => parent.insertBefore(e, pre));
    pre.remove();
  }
  return els;
}

/** Text of a block for a code block: marks dropped, <br> -> newline. */
function codeTextOf(block) {
  if (tagOf(block) === 'PRE') return preText(block);
  return readInline(block).segs.map((s) => (s.atom ? (s.br && s.len ? '\n' : '') : s.text)).join('');
}

function toTopPlain(b) {
  let el = b;
  if (tagOf(el) === 'LI') el = liftToTop(el);
  if (tagOf(el.parentNode) === 'BLOCKQUOTE') unquote(el);
  return el;
}

function applyBlock(blocks, target) {
  if (target === 'code') {
    const plain = blocks.map((b) => (tagOf(b) === 'PRE' ? b : toTopPlain(b)));
    const groups = [];
    for (const b of plain) {
      const g = groups[groups.length - 1];
      if (g && g[g.length - 1].nextElementSibling === b) g.push(b);
      else groups.push([b]);
    }
    for (const g of groups) {
      const firstPre = g.find((b) => tagOf(b) === 'PRE');
      const langEl = firstPre && firstPre.querySelector('code[data-lang]');
      const pre = makePre(docOf(g[0]), g.map(codeTextOf).join('\n'), langEl && langEl.getAttribute('data-lang'));
      g[0].parentNode.insertBefore(pre, g[0]);
      g.forEach((b) => b.remove());
    }
    return;
  }
  for (const b of blocks) {
    if (tagOf(b) === 'PRE') { preToBlocks(b, target); continue; }
    let el = b;
    if (tagOf(el) === 'LI') el = liftToTop(el);
    if (target === 'quote') {
      if (tagOf(el.parentNode) === 'BLOCKQUOTE' && tagOf(el) === 'P') continue;
      if (tagOf(el.parentNode) === 'BLOCKQUOTE') unquote(el);
      el = retag(el, 'p');
      quoteWrap(el);
    } else {
      if (tagOf(el.parentNode) === 'BLOCKQUOTE') unquote(el);
      retag(el, target);
    }
  }
}

/* =====================================================================
   Block commands
   ===================================================================== */

/** Sets paragraph/heading/quote/code on every touched block; toggles back to 'p' when all already are. */
export function setBlock(root, type) {
  if (!BLOCK_TYPES.includes(type)) return false;
  const c = ctx(root);
  if (!c) return false;
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  const blocks = touched(c, true).map((t) => t.block).filter((b) => blockKind(b) !== 'cell');
  if (!blocks.length) return false;
  const kinds = blocks.map(blockKind);
  const target = kinds.every((k) => k === type) ? 'p' : type;
  if (target === 'p' && kinds.every((k) => k === 'p')) return false;
  applyBlock(blocks, target);
  restoreSelection(root, saved);
  return true;
}

/** Toggles bullet / numbered / task list over the touched blocks. */
export function toggleList(root, type) {
  if (!LIST_TYPES.includes(type)) return false;
  const c = ctx(root);
  if (!c) return false;
  const doc = docOf(root);
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  const parts = touched(c, true).map((t) => t.block).filter((b) => blockKind(b) !== 'cell');
  if (!parts.length) return false;
  if (parts.every((b) => tagOf(b) === 'LI' && listKind(root, b) === type)) {
    for (const b of parts) liftToTop(b);
    restoreSelection(root, saved);
    return true;
  }
  const blocks = [];
  for (const b of parts) {
    if (tagOf(b) === 'PRE') blocks.push(...preToBlocks(b, 'p'));
    else blocks.push(b);
  }
  const lists = new Set();
  for (const b of blocks) {
    if (tagOf(b) === 'LI') {
      const list = b.parentNode;
      lists.add(listTypeOf(list) === type ? list : switchList(list, type));
      continue;
    }
    let el = b;
    if (tagOf(el.parentNode) === 'BLOCKQUOTE') unquote(el);
    const li = doc.createElement('li');
    while (el.firstChild) li.appendChild(el.firstChild);
    if (type === 'task') conformItem(li, 'task');
    ensurePlaceholder(li);
    const prev = el.previousElementSibling;
    let list;
    if (prev && LIST.has(tagOf(prev)) && listTypeOf(prev) === type) list = prev;
    else {
      list = makeList(doc, type);
      el.parentNode.insertBefore(list, el);
    }
    list.appendChild(li);
    el.remove();
    lists.add(list);
  }
  for (const l of lists) mergeAround(l);
  restoreSelection(root, saved);
  return true;
}

function selectedItems(root, c) {
  const items = touched(c, true).map((t) => t.block).filter((b) => tagOf(b) === 'LI');
  const set = new Set(items);
  // skip items whose ancestor item is also selected (they move with it)
  return items.filter((li) => {
    for (let n = li.parentNode; n && n !== root; n = n.parentNode) if (set.has(n)) return false;
    return true;
  });
}

/** Nests the selected list items under their previous sibling (Tab). Returns false when nothing could move. */
export function indent(root) {
  const c = ctx(root);
  if (!c) return false;
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  let changed = false;
  for (const li of selectedItems(root, c)) {
    const prev = li.previousElementSibling;
    if (!prev || tagOf(prev) !== 'LI') continue;
    const list = li.parentNode;
    let sub = prev.lastElementChild;
    if (!sub || !sameListType(sub, list)) {
      sub = cloneList(list);
      prev.appendChild(sub);
    }
    sub.appendChild(li);
    mergeAdjacentChildLists(li);
    changed = true;
  }
  if (changed) restoreSelection(root, saved);
  return changed;
}

/** Moves the selected list items one level up (Shift+Tab); a top-level item becomes a paragraph. */
export function outdent(root) {
  const c = ctx(root);
  if (!c) return false;
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  const items = selectedItems(root, c);
  if (!items.length) return false;
  for (const li of items) {
    if (isNestedItem(li)) outdentItem(li);
    else liftItem(li);
  }
  restoreSelection(root, saved);
  return true;
}

/* =====================================================================
   Links
   ===================================================================== */

/** Validates/normalizes a link URL: http(s)/mailto only; bare domains get https://, e-mails mailto:. */
export function normalizeUrl(url) {
  const u = String(url ?? '').trim();
  if (!u || /\s/.test(u)) return null;
  if (/^https?:\/\/[^/\s]+/i.test(u)) return u;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(u)) return u;
  if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(u)) return `mailto:${u}`;
  if (/^(www\.)?[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(:\d+)?([/?#].*)?$/u.test(u)) return `https://${u}`;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(u)) return `http://${u}`;
  return null;
}

function linkRun(segs, off, href) {
  // contiguous segments around `off` carrying the same link
  let s = off; let e = off;
  for (const x of segs) {
    if (!x.atom && x.marks.link && x.marks.link.href === href && x.start <= off && off <= x.end) { s = x.start; e = x.end; break; }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of segs) {
      if (x.atom || !x.marks.link || x.marks.link.href !== href) continue;
      if (x.end === s && x.start < s) { s = x.start; grew = true; }
      if (x.start === e && x.end > e) { e = x.end; grew = true; }
    }
  }
  return [s, e];
}

/**
 * Sets (url) or removes (null) a link on the selection. A caret inside a link edits /
 * unlinks the whole link; a caret elsewhere inserts the URL as linked text.
 * Returns false for an invalid URL.
 */
export function setLink(root, url) {
  const c = ctx(root);
  if (!c) return false;
  const href = url == null || url === '' ? null : normalizeUrl(url);
  if (url != null && url !== '' && !href) return false;
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  if (c.collapsed) {
    const block = c.blocks[c.a.i];
    if (tagOf(block) === 'PRE') return false;
    const m = readInline(block);
    const at = m.segs.find((x) => !x.atom && x.marks.link && x.start <= c.a.off && c.a.off <= x.end
      && (x.start < c.a.off || x.end > c.a.off));
    if (at) {
      const [s, e] = linkRun(m.segs, c.a.off, at.marks.link.href);
      splitAt(m.segs, s); splitAt(m.segs, e);
      for (const x of textSegsIn(m.segs, s, e)) {
        const mk = { ...x.marks };
        if (href) mk.link = { href, attrs: x.marks.link.attrs }; else delete mk.link;
        x.marks = mk;
      }
      writeInline(m);
      restoreSelection(root, saved);
      return true;
    }
    if (!href) return false;
    const text = String(url).trim();
    const marks = { ...caretMarks(m, c.a.off), link: { href, attrs: {} } };
    delete marks.code;
    replaceInSegs(m.segs, c.a.off, c.a.off, text, marks);
    writeInline(m);
    restoreSelection(root, { start: saved.start + text.length, end: saved.start + text.length }, 'end');
    caretOutOfLink(root);
    return true;
  }
  const models = []; const sel = [];
  for (const t of touched(c)) {
    if (tagOf(t.block) === 'PRE') continue;
    const m = readInline(t.block);
    let { s, e } = t;
    // a selection entirely inside one link edits the whole link
    const inner = textSegsIn((() => { const cp = m.segs.map((x) => ({ ...x })); splitAt(cp, s); splitAt(cp, e); return cp; })(), s, e);
    if (href && c.a.i === c.b.i && inner.length && inner.every((x) => x.marks.link && x.marks.link.href === inner[0].marks.link.href)) {
      [s, e] = linkRun(m.segs, s, inner[0].marks.link.href);
    }
    splitAt(m.segs, s); splitAt(m.segs, e);
    const segs = textSegsIn(m.segs, s, e);
    if (!segs.length) continue;
    models.push(m); sel.push(...segs);
  }
  if (!sel.length) return false;
  for (const x of sel) {
    const mk = { ...x.marks };
    if (href) mk.link = { href, attrs: (x.marks.link && x.marks.link.attrs) || {} }; else delete mk.link;
    x.marks = mk;
  }
  models.forEach((m) => writeInline(m));
  restoreSelection(root, saved);
  return true;
}

/** Moves a caret sitting at the very end of a link to just after the <a>. */
function caretOutOfLink(root) {
  const r = getRange(root);
  if (!r || !r.collapsed) return;
  let n = r.startContainer;
  if (!isText(n) || r.startOffset !== n.data.length) return;
  while (n.parentNode && n.parentNode !== root && !n.nextSibling) {
    n = n.parentNode;
    if (tagOf(n) === 'A') {
      const p = { node: n.parentNode, offset: indexOf(n) + 1 };
      setRange(root, p, p);
      return;
    }
  }
}

/* =====================================================================
   Insert hr / table
   ===================================================================== */

function splitBlockAt(block, off) {
  const m = readInline(block);
  splitAt(m.segs, off);
  const left = m.segs.filter((s) => s.end <= off && !(s.len === 0 && s.start === off && s.start !== 0));
  const right = m.segs.filter((s) => !left.includes(s));
  const doc = docOf(block);
  const el = doc.createElement(tagOf(block).toLowerCase());
  writeInline(m, left);
  const frag = render(doc, right);
  if (!frag.childNodes.length) frag.appendChild(doc.createElement('br'));
  el.appendChild(frag);
  block.parentNode.insertBefore(el, block.nextSibling);
  return el;
}

const TEXT_CAPABLE = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'DIV']);

function insertBlockEl(root, el) {
  const doc = docOf(root);
  const c = ctx(root);
  if (!c) root.appendChild(el);
  else {
    const b = c.blocks[c.b.i];
    const off = c.b.off;
    let top = b;
    while (top.parentNode !== root) top = top.parentNode;
    if (top === b && /^(P|DIV|H[1-6])$/.test(tagOf(b))) {
      const len = c.lens[c.b.i];
      if (len === 0) root.replaceChild(el, b);
      else if (off === 0) root.insertBefore(el, b);
      else if (off >= len) root.insertBefore(el, b.nextSibling);
      else { splitBlockAt(b, off); root.insertBefore(el, b.nextSibling); }
    } else root.insertBefore(el, top.nextSibling);
  }
  const next = el.nextElementSibling;
  if (!next || !TEXT_CAPABLE.has(tagOf(next))) {
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    el.parentNode.insertBefore(p, el.nextSibling);
  }
  clearPendingMarks(root);
}

function firstBlockIn(el) {
  const t = tagOf(el);
  if (/^(P|PRE|H[1-6]|LI|TD|TH|DIV)$/.test(t) && !hasBlockChild(el)) return el;
  return collectBlocks(el, [])[0] || null;
}

/** Inserts a divider after the caret's block (splitting a paragraph at the caret). */
export function insertHr(root) {
  const hr = docOf(root).createElement('hr');
  insertBlockEl(root, hr);
  const b = firstBlockIn(hr.nextElementSibling);
  if (b) placeCaret(root, b, 0);
  return true;
}

/** Inserts a GFM table: 1 header row + (rows-1) body rows; caret goes into the first cell. */
export function insertTable(root, rows = 3, cols = 3) {
  const doc = docOf(root);
  rows = Math.max(1, Math.min(100, Math.floor(Number(rows) || 3)));
  cols = Math.max(1, Math.min(20, Math.floor(Number(cols) || 3)));
  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const tbody = doc.createElement('tbody');
  const row = (tag) => {
    const tr = doc.createElement('tr');
    for (let i = 0; i < cols; i++) {
      const cell = doc.createElement(tag);
      cell.appendChild(doc.createElement('br'));
      tr.appendChild(cell);
    }
    return tr;
  };
  thead.appendChild(row('th'));
  for (let r = 1; r < rows; r++) tbody.appendChild(row('td'));
  table.appendChild(thead);
  table.appendChild(tbody);
  insertBlockEl(root, table);
  placeCaret(root, table.querySelector('th'), 0);
  return true;
}

/* =====================================================================
   Case transforms (Vietnamese-aware)
   ===================================================================== */

const up = (ch) => { try { return ch.toLocaleUpperCase('vi'); } catch { return ch.toUpperCase(); } };
const low = (ch) => { try { return ch.toLocaleLowerCase('vi'); } catch { return ch.toLowerCase(); } };
const WORD_RE = /[\p{L}\p{M}\p{N}]/u;
const LETTER_RE = /\p{L}/u;
const isWordChar = (ch) => !!ch && WORD_RE.test(ch);
const keepLen = (f) => (ch) => { const r = f(ch); return r.length === ch.length ? r : ch; };
const upK = keepLen(up);
const lowK = keepLen(low);

function isWordStart(str, i) {
  const p = str[i - 1];
  if (isWordChar(p)) return false;
  if ((p === "'" || p === '’') && isWordChar(str[i - 2])) return false;
  return true;
}

/** Transforms str[s, e) keeping its length. mode: upper|lower|title|sentence. */
export function caseTransform(str, s, e, mode) {
  const out = str.split('');
  if (mode === 'upper' || mode === 'lower') {
    const f = mode === 'upper' ? upK : lowK;
    for (let i = s; i < e; i++) out[i] = f(str[i]);
  } else if (mode === 'title') {
    for (let i = s; i < e; i++) {
      if (!LETTER_RE.test(str[i])) continue;
      out[i] = isWordStart(str, i) ? upK(str[i]) : lowK(str[i]);
    }
  } else if (mode === 'sentence') {
    let capNext = true; let endMark = false;
    for (let i = 0; i < e; i++) {
      const ch = str[i];
      if (LETTER_RE.test(ch)) {
        if (i >= s) out[i] = capNext ? upK(ch) : lowK(ch);
        capNext = false; endMark = false;
      } else if (/\p{N}/u.test(ch)) { capNext = false; endMark = false; }
      else if (/[.!?…]/.test(ch)) endMark = true;
      else if (ch === '\n') { capNext = true; endMark = false; }
      else if (/\s/.test(ch)) { if (endMark) capNext = true; }
    }
  } else return str;
  return out.join('');
}

/** Changes case of the selection (or of the word at a collapsed caret); marks and links are kept. */
export function transformCase(root, mode) {
  if (!['upper', 'lower', 'title', 'sentence'].includes(mode)) return false;
  const c = ctx(root);
  if (!c) return false;
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  let parts;
  if (c.collapsed) {
    const block = c.blocks[c.a.i];
    const str = modelString(readInline(block));
    let s = c.a.off; let e = c.a.off;
    while (s > 0 && isWordChar(str[s - 1])) s--;
    while (e < str.length && isWordChar(str[e])) e++;
    if (s === e) return false;
    parts = [{ block, s, e }];
  } else parts = touched(c);
  let changed = false;
  for (const t of parts) {
    const m = readInline(t.block);
    const str = modelString(m);
    const out = caseTransform(str, t.s, t.e, mode);
    if (out === str) continue;
    for (const seg of m.segs) {
      if (seg.atom) continue;
      const ns = out.slice(seg.start, seg.end);
      if (ns !== seg.node.data) { seg.node.data = ns; changed = true; }
    }
  }
  restoreSelection(root, saved);
  return changed;
}

/* =====================================================================
   Clear formatting / active state
   ===================================================================== */

/** Removes inline marks (links are kept) and turns headings/quotes/code blocks into paragraphs. Lists are kept. */
export function clearFormatting(root) {
  const c = ctx(root);
  if (!c) return false;
  const saved = { start: globalOf(c, c.a), end: globalOf(c, c.b) };
  let changed = false;
  if (c.collapsed) {
    const block = c.blocks[c.a.i];
    const cur = caretMarks(readInline(block), c.a.off);
    const p = validPending(root, c) || { marks: {}, g: globalOf(c, c.a), block };
    for (const k of MARKS) {
      if (cur[k]) { p.marks[k] = false; changed = true; } else if (k in p.marks) { delete p.marks[k]; changed = true; }
    }
    if (Object.keys(p.marks).length) pendingStore.set(root, p); else pendingStore.delete(root);
  } else {
    for (const t of touched(c)) {
      if (tagOf(t.block) === 'PRE') continue;
      const m = readInline(t.block);
      splitAt(m.segs, t.s); splitAt(m.segs, t.e);
      const segs = textSegsIn(m.segs, t.s, t.e).filter((x) => MARKS.some((k) => x.marks[k]));
      if (!segs.length) continue;
      for (const x of segs) x.marks = x.marks.link ? { link: x.marks.link } : NO_MARKS;
      writeInline(m);
      changed = true;
    }
  }
  const blocks = touched(c, true).map((t) => t.block)
    .filter((b) => b.parentNode && ['h1', 'h2', 'h3', 'quote', 'code'].includes(blockKind(b)));
  if (blocks.length) { applyBlock(blocks, 'p'); changed = true; }
  restoreSelection(root, saved);
  return changed;
}

/** Formatting state at the caret / selection (a mark is true only when the whole selection has it). */
export function activeState(root) {
  const st = {
    bold: false, italic: false, underline: false, strike: false, mark: false, code: false,
    link: false, href: null, block: 'p', list: null, table: false,
  };
  const c = ctx(root);
  if (!c) return st;
  const first = c.blocks[c.a.i];
  const kind = blockKind(first);
  st.block = kind === 'li' || kind === 'cell' ? 'p' : kind;
  st.list = listKind(root, first);
  st.table = kind === 'cell';
  if (kind === 'code') return st;
  let marks = null;
  if (!c.collapsed) {
    const sel = [];
    for (const t of touched(c)) {
      if (tagOf(t.block) === 'PRE') continue;
      const m = readInline(t.block);
      splitAt(m.segs, t.s); splitAt(m.segs, t.e);
      sel.push(...textSegsIn(m.segs, t.s, t.e));
    }
    if (sel.length) {
      for (const k of MARKS) st[k] = sel.every((x) => !!x.marks[k]);
      st.link = sel.every((x) => !!x.marks.link);
      if (st.link) {
        const h = sel[0].marks.link.href;
        st.href = sel.every((x) => x.marks.link.href === h) ? h : null;
      }
      return st;
    }
  }
  const m = readInline(first);
  marks = caretMarks(m, c.a.off);
  // a caret inside a link (not only at its end) reports the link
  const inLink = m.segs.find((x) => !x.atom && x.marks.link && x.start < c.a.off && c.a.off < x.end)
    || m.segs.find((x) => !x.atom && x.marks.link && x.start < c.a.off && c.a.off <= x.end);
  const p = validPending(root, c);
  marks = effectiveMarks(marks, p && p.marks);
  for (const k of MARKS) st[k] = !!marks[k];
  if (inLink) { st.link = true; st.href = inLink.marks.link.href; }
  return st;
}

/* =====================================================================
   Find / replace
   ===================================================================== */

const fold = (s) => s.split('').map(lowK).join('');

function matchesIn(str, query, opts) {
  const cs = !!(opts && opts.caseSensitive);
  const hay = cs ? str : fold(str);
  const q = cs ? query : fold(query);
  const out = [];
  let i = 0;
  while (q && i <= hay.length) {
    const j = hay.indexOf(q, i);
    if (j < 0) break;
    const ok = !(opts && opts.wholeWord) || (!isWordChar(str[j - 1]) && !isWordChar(str[j + q.length]));
    if (ok) { out.push([j, j + q.length]); i = j + q.length; } else i = j + 1;
  }
  return out;
}

/** All matches of `query` (case-insensitive by default, Vietnamese folding) as DOM Ranges. */
export function findAll(root, query, opts = {}) {
  query = String(query ?? '');
  if (!root || !query) return [];
  const doc = docOf(root);
  const ranges = [];
  for (const block of textBlocks(root)) {
    const str = modelString(readInline(block));
    for (const [s, e] of matchesIn(str, query, opts)) {
      const a = pointAt(block, s, 'start'); const b = pointAt(block, e, 'end');
      const r = doc.createRange();
      r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
      ranges.push(r);
    }
  }
  return ranges;
}

function replaceInSegs(segs, s, e, text, marks) {
  splitAt(segs, s); splitAt(segs, e);
  const removed = segs.filter((x) => x.len > 0 && x.start >= s && x.end <= e);
  const firstText = removed.find((x) => !x.atom);
  const mk = marks || (firstText ? firstText.marks : NO_MARKS);
  let idx = segs.findIndex((x) => x.start >= s && x.len > 0);
  if (idx < 0) idx = segs.findIndex((x) => x.start >= s);
  if (idx < 0) idx = segs.length;
  for (const r of removed) segs.splice(segs.indexOf(r), 1);
  idx = Math.min(idx, segs.length);
  if (text) segs.splice(idx, 0, { text, marks: mk });
  measure(segs);
}

/** Replaces every match; returns the number of replacements. */
export function replaceAll(root, query, repl, opts = {}) {
  query = String(query ?? '');
  repl = String(repl ?? '');
  if (!root || !query) return 0;
  const saved = saveSelection(root);
  let count = 0;
  for (const block of textBlocks(root)) {
    const m = readInline(block);
    const str = modelString(m);
    const found = matchesIn(str, query, opts);
    if (!found.length) continue;
    count += found.length;
    if (tagOf(block) === 'PRE') {
      let out = str;
      for (const [s, e] of [...found].reverse()) out = out.slice(0, s) + repl + out.slice(e);
      setPreText(block, out.endsWith('\n') ? out.slice(0, -1) : out);
      continue;
    }
    for (const [s, e] of [...found].reverse()) replaceInSegs(m.segs, s, e, repl);
    writeInline(m);
  }
  if (count && saved) restoreSelection(root, saved);
  return count;
}

/** Replaces the text of one Range (inside a single block) and selects the new text. */
export function replaceRange(root, range, text) {
  if (!root || !range) return false;
  text = String(text ?? '');
  const blocks = textBlocks(root);
  const index = new Map(blocks.map((b, i) => [b, i]));
  const a = locate(root, blocks, index, range.startContainer, range.startOffset, 'start');
  const b = locate(root, blocks, index, range.endContainer, range.endOffset, 'end');
  if (a.i !== b.i || b.off < a.off) return false;
  const block = blocks[a.i];
  let g = 0;
  for (let i = 0; i < a.i; i++) g += blockLen(blocks[i]) + 1;
  if (tagOf(block) === 'PRE') {
    const str = modelString(readInline(block));
    setPreText(block, str.slice(0, a.off) + text + str.slice(b.off));
  } else {
    const m = readInline(block);
    replaceInSegs(m.segs, a.off, b.off, text);
    writeInline(m);
  }
  restoreSelection(root, { start: g + a.off, end: g + a.off + text.length });
  return true;
}
