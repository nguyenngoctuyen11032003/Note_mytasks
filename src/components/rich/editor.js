// Rich text (WYSIWYG) editor core for Notes (stream A3).
// Contract: docs/rich-editor-design.md → "editor.js".
//
//   createRichEditor(container, {
//     markdown, readOnly = false, placeholder,
//     onChange(markdown),          // debounced 300 ms, only when the canonical Markdown changed
//     onSelectionChange(state),    // commands.activeState() for toolbar highlighting
//     uploadImage(file) → Promise<{ url }>,
//     onImageFiles(files, { range }),        // pasted/dropped image files (images.js insert)
//     transformPastedMarkdown(md) → md | Promise<md>, // awaited before pasted Markdown is inserted
//   }) → {
//     el, getMarkdown(), setMarkdown(md, { emit, history }), focus(where?), exec(cmd, ...args), state(),
//     insertMarkdown(md), undo(), redo(), canUndo(), canRedo(),
//     flush(), notifyChange(), setReadOnly(bool), isEmpty(), destroy(),
//   }
//
// Markdown is the source of truth: the DOM follows the dialect table of the design doc,
// built only by markdown.js (mdToHtml) or by the commands/handlers below, so unknown
// HTML never reaches the editor. Pasted HTML is sanitised into the dialect, serialised
// with htmlToMd and re-parsed — the Markdown model is the sanitiser of last resort.
//
// Events dispatched on `el` (all bubble):
//   rt:request-image  / rt:request-record   slash menu "Ảnh" / "Ghi âm"
//   rt:request-link   {href, apply(url)}    Ctrl+K — cancel it to show your own dialog
//                                           (otherwise window.prompt is used)
//   rt:request-find   {replace}             Ctrl+F / Ctrl+H — cancel it when handled
//   rt:image-files    {files, range}        pasted/dropped images when options.onImageFiles(files, {range})
//                                           is not given — cancel it to handle the
//                                           upload yourself (images.js insertImages);
//                                           otherwise the built-in placeholder + uploadImage runs
//   rt:upload-error   {error, file}         built-in upload failed
//   rt:render                               DOM rebuilt from Markdown (setMarkdown, undo/redo,
//                                           paste, insertMarkdown, uploaded image) → hydrate media
import { mdToHtml, htmlToMd } from './markdown.js';
import * as commands from './commands.js';
import { createSlashMenu } from './slashMenu.js';

const LEAF_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'LI', 'TD', 'TH']);
const SKIP_IN_LEAF = new Set(['UL', 'OL', 'TABLE', 'FIGURE', 'BLOCKQUOTE', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'HR']);
const ROOT_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'FIGURE', 'DIV']);
const HEADING_RE = /^H[1-6]$/;
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const MEDIA_SRC = /^(nm-media:|https?:\/\/)/i;
const HISTORY_MAX = 200;
const COALESCE_MS = 1000;
const CHANGE_MS = 300;
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

const isEl = (n, tag) => !!n && n.nodeType === 1 && (!tag || n.tagName === tag);
const isText = (n) => !!n && n.nodeType === 3;
const isUi = (n) =>
  isEl(n) && (n.getAttribute('contenteditable') === 'false' || n.tagName === 'INPUT' || n.tagName === 'BUTTON');
const isList = (n) => isEl(n) && (n.tagName === 'UL' || n.tagName === 'OL');
const indexOf = (n) => Array.prototype.indexOf.call(n.parentNode.childNodes, n);

/* =====================================================================
   Offsets inside a text block ("leaf": p, h*, pre, li, td, th)
   Own content = text nodes + <br> (+ <img>) not inside nested lists / UI.
   A trailing <br> is a caret placeholder and does not count.
   ===================================================================== */

export function ownNodes(block) {
  const out = [];
  const rec = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (c.data) out.push(c);
      }
      else if (c.nodeType === 1) {
        if (c.tagName === 'BR' || c.tagName === 'IMG') out.push(c);
        else if (isUi(c) || SKIP_IN_LEAF.has(c.tagName)) continue;
        else rec(c);
      }
    }
  };
  rec(block);
  const last = out[out.length - 1];
  if (isEl(last, 'BR')) out.pop();
  return out;
}
const nlen = (n) => (n.nodeType === 3 ? n.data.length : 1);
export const textOf = (block) => ownNodes(block).map((n) => (n.nodeType === 3 ? n.data : '\n')).join('');
const isBlank = (block) => !textOf(block).replace(/[\s​⁠﻿]/g, '');

/** Is node n at or after the boundary point (container, offset)? */
function atOrAfter(container, offset, n) {
  if (container.nodeType === 3) {
    if (n === container) return false;
    return !!(container.compareDocumentPosition(n) & FOLLOWING) && !n.contains(container);
  }
  const child = container.childNodes[offset];
  if (child) return child === n || child.contains(n) || !!(child.compareDocumentPosition(n) & FOLLOWING);
  return !container.contains(n) && !!(container.compareDocumentPosition(n) & FOLLOWING);
}

export function offsetIn(block, node, off) {
  let acc = 0;
  for (const n of ownNodes(block)) {
    if (n === node && node.nodeType === 3) return acc + Math.min(off, n.data.length);
    if (atOrAfter(node, off, n)) return acc;
    acc += nlen(n);
  }
  return acc;
}

export function pointAt(block, k) {
  const nodes = ownNodes(block);
  k = Math.max(0, k);
  for (const n of nodes) {
    if (n.nodeType === 3) {
      if (k <= n.data.length) return [n, k];
      k -= n.data.length;
    } else {
      if (k === 0) return [n.parentNode, indexOf(n)];
      k -= 1;
    }
  }
  const last = nodes[nodes.length - 1];
  if (last) return last.nodeType === 3 ? [last, last.data.length] : [last.parentNode, indexOf(last) + 1];
  if (block.tagName === 'PRE') {
    const code = block.querySelector('code');
    if (code) return [code, 0];
  }
  let i = 0;
  const cs = block.childNodes;
  while (i < cs.length && (isUi(cs[i]) || (isText(cs[i]) && !cs[i].data))) i++;
  return [block, i];
}

/** Last / first leaf (text block) inside a node, or null for figures / hr. */
function lastLeafIn(n) {
  if (!isEl(n)) return null;
  if (n.tagName === 'LI') {
    const sub = [...n.children].filter(isList).pop();
    const li = sub && [...sub.children].filter((c) => c.tagName === 'LI').pop();
    return li ? lastLeafIn(li) : n;
  }
  if (LEAF_TAGS.has(n.tagName)) return n;
  if (isList(n) || n.tagName === 'BLOCKQUOTE' || n.tagName === 'TABLE' || n.tagName === 'TBODY' || n.tagName === 'TR' || n.tagName === 'DIV') {
    for (let c = n.lastElementChild; c; c = c.previousElementSibling) {
      const l = lastLeafIn(c);
      if (l) return l;
    }
  }
  return null;
}
function firstLeafIn(n) {
  if (!isEl(n)) return null;
  if (LEAF_TAGS.has(n.tagName)) return n;
  if (isList(n) || ['BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'DIV'].includes(n.tagName)) {
    for (let c = n.firstElementChild; c; c = c.nextElementSibling) {
      const l = firstLeafIn(c);
      if (l) return l;
    }
  }
  return null;
}

/* =====================================================================
   Clipboard HTML → dialect DOM (sanitiser)
   ===================================================================== */

const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'XML', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG',
  'CANVAS', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'NOSCRIPT', 'VIDEO', 'AUDIO', 'MATH', 'O:P', 'COLGROUP', 'COL',
]);
const BLOCKISH = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'FIGURE',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'DL', 'DT', 'DD', 'ADDRESS', 'CENTER', 'FORM',
  'FIELDSET', 'DETAILS', 'SUMMARY', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
]);
const MARK_OF_TAG = {
  B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', CITE: 'em', VAR: 'em', DFN: 'em', U: 'u', INS: 'u',
  S: 's', STRIKE: 's', DEL: 's', MARK: 'mark', CODE: 'code', KBD: 'code', SAMP: 'code', TT: 'code',
};

function styleMarks(elm) {
  const st = (elm.getAttribute('style') || '').toLowerCase();
  const out = [];
  if (!st) return { add: out, noBold: false };
  const get = (prop) => {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(st);
    return m ? m[1].trim() : '';
  };
  const fw = get('font-weight');
  const noBold = /^(normal|[1-5]00|lighter)/.test(fw);
  if (/^(bold|bolder|[6-9]00)/.test(fw)) out.push('strong');
  if (/italic|oblique/.test(get('font-style'))) out.push('em');
  const deco = `${get('text-decoration')} ${get('text-decoration-line')}`;
  if (/underline/.test(deco) && !/none/.test(get('text-underline'))) out.push('u');
  if (/line-through/.test(deco)) out.push('s');
  const bg = get('background-color') || get('background') || get('mso-highlight');
  if (bg && !/^(transparent|none|white|#fff(fff)?|rgba?\(\s*255\s*,\s*255\s*,\s*255|rgba\([^)]*,\s*0\s*\)|initial|inherit|windowtext|auto)/.test(bg)) out.push('mark');
  if (/monospace|consolas|courier|menlo|monaco/.test(get('font-family'))) out.push('code');
  return { add: out, noBold };
}

const msoList = (elm) => {
  const st = elm.getAttribute?.('style') || '';
  const m = /mso-list\s*:\s*([^;"]+)/i.exec(st);
  if (!m || /ignore/i.test(m[1])) return null;
  const lv = /level(\d+)/i.exec(m[1]);
  return { level: lv ? Number(lv[1]) : 1 };
};

/**
 * Converts arbitrary clipboard HTML into a detached <div> containing only dialect
 * elements (p, h1-3, strong/em/u/s/mark/code/a, ul/ol/li, blockquote, pre>code, table,
 * hr, figure.rt-img / .rt-audio). Pass it to htmlToMd.
 */
export function sanitizeHtml(htmlStr, doc = document) {
  const out = doc.createElement('div');
  let src;
  try {
    src = new DOMParser().parseFromString(String(htmlStr || ''), 'text/html').body;
  } catch {
    return out;
  }
  if (!src) return out;
  // Chrome/Word fragments: keep only what is between StartFragment / EndFragment comments.
  walkBlocks(src, out, doc);
  // drop empty paragraphs
  for (const p of [...out.querySelectorAll('p,h1,h2,h3')]) {
    if (!p.textContent.replace(/[\s​]/g, '') && !p.querySelector('br,figure')) p.remove();
  }
  return out;
}

function makeFigure(doc, srcUrl, alt, cls = 'rt-img', w = null) {
  const fig = doc.createElement('figure');
  fig.className = cls;
  fig.setAttribute('contenteditable', 'false');
  fig.setAttribute('data-src', srcUrl);
  if (cls === 'rt-img') {
    if (w) fig.setAttribute('data-w', w);
    const img = doc.createElement('img');
    img.setAttribute('alt', alt || '');
    fig.appendChild(img);
  } else {
    fig.appendChild(doc.createElement('audio')).setAttribute('controls', '');
    fig.appendChild(doc.createElement('figcaption')).textContent = alt || '';
  }
  return fig;
}

function figureFrom(node, doc) {
  if (node.tagName === 'FIGURE') {
    const s = node.getAttribute('data-src') || node.querySelector('img,audio')?.getAttribute('src') || '';
    if (!MEDIA_SRC.test(s)) return null;
    if (node.classList.contains('rt-audio') || node.querySelector('audio')) {
      return makeFigure(doc, s, node.querySelector('figcaption')?.textContent || 'Ghi âm', 'rt-audio');
    }
    const w = node.getAttribute('data-w');
    return makeFigure(doc, s, node.querySelector('img')?.getAttribute('alt') || '', 'rt-img', /^\d{1,3}$/.test(w || '') ? w : null);
  }
  const s = node.getAttribute('data-src') || node.getAttribute('src') || '';
  if (!/^https?:\/\//i.test(s) && !/^nm-media:/i.test(s)) return null;
  return makeFigure(doc, s, node.getAttribute('alt') || '');
}

function walkBlocks(src, outParent, doc) {
  let run = null; // current <p> collecting inline content
  const pendingFigs = [];
  const flushFigs = () => {
    while (pendingFigs.length) outParent.appendChild(pendingFigs.shift());
  };
  const inlineTarget = () => {
    if (!run) {
      run = doc.createElement('p');
      outParent.appendChild(run);
    }
    return run;
  };
  const endRun = () => {
    run = null;
    flushFigs();
  };
  let listStack = null; // Word list paragraphs: [{ level, list, li }]

  for (let c = src.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 8) continue;
    if (c.nodeType === 3) {
      if (!run && !c.data.trim()) continue;
      listStack = null;
      walkInline(c, inlineTarget(), doc, new Set(), pendingFigs);
      continue;
    }
    if (c.nodeType !== 1) continue;
    const t = c.tagName.toUpperCase();
    if (DROP_TAGS.has(t)) continue;
    if (t === 'IMG') {
      const f = figureFrom(c, doc);
      if (f) {
        endRun();
        outParent.appendChild(f);
      }
      continue;
    }
    if (!BLOCKISH.has(t)) {
      if (t === 'BR' && !run) continue;
      listStack = null;
      walkInline(c, inlineTarget(), doc, new Set(), pendingFigs, true);
      continue;
    }
    endRun();
    const ml = (t === 'P' || t === 'DIV') && msoList(c);
    if (ml) {
      listStack = wordListItem(c, ml.level, outParent, listStack, doc, pendingFigs);
      flushFigs();
      continue;
    }
    listStack = null;
    if (/^H[1-6]$/.test(t)) {
      const h = doc.createElement(`h${Math.min(3, Number(t[1]))}`);
      walkInline(c, h, doc, new Set(), pendingFigs);
      outParent.appendChild(h);
    } else if (t === 'UL' || t === 'OL') {
      outParent.appendChild(convertList(c, doc, pendingFigs));
    } else if (t === 'BLOCKQUOTE') {
      const bq = doc.createElement('blockquote');
      walkBlocks(c, bq, doc);
      if (bq.childNodes.length) outParent.appendChild(bq);
    } else if (t === 'PRE') {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      const lang = /language-([\w+#.-]+)/.exec(c.querySelector('code')?.className || '')?.[1];
      if (lang) code.setAttribute('data-lang', lang);
      code.textContent = (c.innerText ?? c.textContent).replace(/\r\n?/g, '\n').replace(/\n$/, '');
      pre.appendChild(code);
      outParent.appendChild(pre);
    } else if (t === 'TABLE') {
      const tb = convertTable(c, doc);
      if (tb) outParent.appendChild(tb);
    } else if (t === 'HR') {
      outParent.appendChild(doc.createElement('hr'));
    } else if (t === 'FIGURE') {
      const f = figureFrom(c, doc);
      if (f) outParent.appendChild(f);
      else walkBlocks(c, outParent, doc);
    } else if (t === 'LI') {
      const ul = doc.createElement('ul');
      ul.appendChild(convertLi(c, doc, pendingFigs));
      outParent.appendChild(ul);
    } else if ([...c.children].some((k) => BLOCKISH.has(k.tagName.toUpperCase()) || k.tagName === 'IMG')) {
      walkBlocks(c, outParent, doc);
    } else {
      const p = doc.createElement('p');
      walkInline(c, p, doc, new Set(), pendingFigs);
      outParent.appendChild(p);
    }
    flushFigs();
  }
  endRun();
}

function wordListItem(pEl, level, outParent, stack, doc, figs) {
  const marker = pEl.querySelector('span[style*="mso-list"]');
  const bullet = (marker?.textContent || '').replace(/ /g, ' ').trim();
  const ordered = /^[(\[]?[\da-zA-Z]{1,4}[.)\]]$/.test(bullet) && !/^[·•o§▪■□◦\-–]$/.test(bullet);
  const li = doc.createElement('li');
  walkInline(pEl, li, doc, new Set(), figs, false, true);
  li.normalize();
  if (li.firstChild && isText(li.firstChild)) li.firstChild.data = li.firstChild.data.replace(/^\s+/, '');
  stack = stack ? stack.filter((s) => s.level <= level) : [];
  let top = stack[stack.length - 1];
  if (top && top.level === level) {
    top.list.appendChild(li);
    top.li = li;
    return stack;
  }
  const list = doc.createElement(ordered ? 'ol' : 'ul');
  list.appendChild(li);
  if (top && top.li) top.li.appendChild(list);
  else outParent.appendChild(list);
  stack.push({ level, list, li });
  return stack;
}

function convertLi(liEl, doc, figs) {
  const li = doc.createElement('li');
  const box = liEl.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
  if (box) li.setAttribute('data-checked', box.checked || box.hasAttribute('checked') ? 'true' : 'false');
  else if (liEl.hasAttribute('data-checked')) li.setAttribute('data-checked', liEl.getAttribute('data-checked') === 'true' ? 'true' : 'false');
  const nested = [];
  const inlineHolder = doc.createElement('span');
  for (const c of [...liEl.childNodes]) {
    if (isEl(c) && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(convertList(c, doc, figs));
    else {
      const tmp = doc.createElement('div');
      tmp.appendChild(c.cloneNode(true));
      walkInline(tmp, inlineHolder, doc, new Set(), figs, true);
    }
  }
  while (inlineHolder.firstChild) li.appendChild(inlineHolder.firstChild);
  trimBr(li);
  nested.forEach((n) => li.appendChild(n));
  return li;
}

function convertList(listEl, doc, figs) {
  const list = doc.createElement(listEl.tagName.toUpperCase() === 'OL' ? 'ol' : 'ul');
  for (const c of listEl.children) {
    const t = c.tagName.toUpperCase();
    if (t === 'LI') list.appendChild(convertLi(c, doc, figs));
    else if (t === 'UL' || t === 'OL') {
      const last = list.lastElementChild;
      if (last) last.appendChild(convertList(c, doc, figs));
    }
  }
  const items = [...list.children];
  if (items.length && items.every((li) => li.hasAttribute('data-checked'))) list.setAttribute('data-type', 'task');
  else items.forEach((li) => li.removeAttribute('data-checked'));
  return list;
}

function convertTable(tableEl, doc) {
  const rows = [...tableEl.querySelectorAll('tr')].filter((tr) => tr.closest('table') === tableEl);
  if (!rows.length) return null;
  const grid = rows.map((tr) => [...tr.children].filter((c) => /^(TD|TH)$/i.test(c.tagName)));
  const cols = Math.max(...grid.map((r) => r.length));
  if (!cols) return null;
  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const tbody = doc.createElement('tbody');
  grid.forEach((cells, i) => {
    const tr = doc.createElement('tr');
    for (let k = 0; k < cols; k++) {
      const cell = doc.createElement(i === 0 ? 'th' : 'td');
      if (cells[k]) {
        walkInline(cells[k], cell, doc, new Set(), [], true);
        // GFM cells are single-line
        cell.querySelectorAll('br').forEach((b) => b.replaceWith(doc.createTextNode(' ')));
      }
      tr.appendChild(cell);
    }
    (i === 0 ? thead : tbody).appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function trimBr(n) {
  while (isEl(n.lastChild, 'BR')) n.lastChild.remove();
  while (isEl(n.firstChild, 'BR')) n.firstChild.remove();
}

/**
 * Appends the inline content of `node` (its children, or itself for text) to `target`,
 * wrapping it in dialect marks. `self` → treat node itself as an inline element.
 */
function walkInline(node, target, doc, marks, figs, self = false, wordList = false) {
  const kids = self || node.nodeType === 3 ? [node] : [...node.childNodes];
  for (const c of kids) {
    if (c.nodeType === 3) {
      const s = c.data.replace(/[\r\n\t ]+/g, ' ').replace(/ /g, ' ');
      if (!s) continue;
      const prev = target.lastChild;
      const txt = (!prev || isEl(prev, 'BR')) && !target.textContent ? s.replace(/^ +/, '') : s;
      if (txt) target.appendChild(doc.createTextNode(txt));
      continue;
    }
    if (c.nodeType !== 1) continue;
    const t = c.tagName.toUpperCase();
    if (DROP_TAGS.has(t)) continue;
    if (wordList && t === 'SPAN' && /mso-list\s*:\s*ignore/i.test(c.getAttribute('style') || '')) continue;
    if (t === 'BR') {
      target.appendChild(doc.createElement('br'));
      continue;
    }
    if (t === 'IMG') {
      const f = figureFrom(c, doc);
      if (f) figs.push(f);
      continue;
    }
    if (t === 'INPUT') continue;
    if (BLOCKISH.has(t)) {
      if (t === 'UL' || t === 'OL' || t === 'TABLE') {
        // nested structure inside inline context: flatten to lines
        if (target.childNodes.length) target.appendChild(doc.createElement('br'));
        walkInline(c, target, doc, marks, figs);
        continue;
      }
      if (target.textContent && !isEl(target.lastChild, 'BR')) target.appendChild(doc.createElement('br'));
      walkInline(c, target, doc, marks, figs, false, wordList);
      continue;
    }
    let tags = [];
    let nextMarks = marks;
    const base = MARK_OF_TAG[t];
    const sm = styleMarks(c);
    if (base && !(base === 'strong' && sm.noBold)) tags.push(base);
    tags.push(...sm.add);
    if (marks.has('code')) tags = [];
    tags = [...new Set(tags)].filter((x) => !marks.has(x));
    let href = null;
    if (t === 'A') {
      const h = (c.getAttribute('href') || '').trim();
      if (SAFE_HREF.test(h) && !marks.has('a')) href = h;
    }
    let host = target;
    if (href) {
      const a = doc.createElement('a');
      a.setAttribute('href', href);
      host.appendChild(a);
      host = a;
      nextMarks = new Set([...nextMarks, 'a']);
    }
    for (const tg of tags) {
      const m = doc.createElement(tg);
      host.appendChild(m);
      host = m;
    }
    if (tags.length) nextMarks = new Set([...nextMarks, ...tags]);
    walkInline(c, host, doc, nextMarks, figs, false, wordList);
    // drop empty wrappers
    let h = host;
    while (h !== target && !h.childNodes.length) {
      const p = h.parentNode;
      h.remove();
      h = p;
    }
  }
}

/**
 * Spaces that the browser would collapse (at a block edge, next to another space)
 * become NBSP — what native typing does. Without this, a space typed by our own
 * handlers at the end of a block is invisible and Chrome moves the caret back
 * into the preceding mark (and the space is lost).
 */
export function keepSpaces(text, prev = '', next = '') {
  const chars = [...String(text)];
  const ws = (c) => !c || c === ' ' || c === '\u00a0' || c === '\n';
  return chars
    .map((c, i) => {
      if (c !== ' ') return c;
      const p = i ? chars[i - 1] : prev;
      const n = i < chars.length - 1 ? chars[i + 1] : next;
      return ws(p) || ws(n) ? '\u00a0' : ' ';
    })
    .join('');
}

/** Heuristic: does plain text use Markdown syntax worth parsing? */
export function looksLikeMarkdown(text) {
  const s = String(text || '');
  return (
    /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s+\S|\d{1,9}[.)]\s+\S|>\s?|```|~~~|\|.*\|\s*$|-{3,}\s*$)/m.test(s) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|==[^=\n]+==|\+\+[^+\n]+\+\+|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|!\[[^\]\n]*\]\([^)\s]+\)/.test(s)
  );
}

const htmlHasContent = (h) => {
  const s = String(h || '');
  if (/<(img|table|hr)\b/i.test(s)) return true;
  return !!s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '');
};

const imageFiles = (list) => [...(list || [])].filter((f) => f && String(f.type || '').startsWith('image/'));

/* =====================================================================
   Input rules
   ===================================================================== */

const BLOCK_RULES = [
  [/^#$/, 'h1'], [/^##$/, 'h2'], [/^###$/, 'h3'],
  [/^[-*+]$/, 'ul'], [/^\d{1,9}[.)]$/, 'ol'],
  [/^\[ ?\]$/, 'task'], [/^\[[xX]\]$/, 'task-done'],
  [/^>$/, 'quote'],
];
const NOT_WORD = '[^\\p{L}\\p{N}_]';
const INLINE_RULES = [
  { re: /(?:^|[^*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/u, len: 2, mark: 'strong' },
  { re: /(?:^|[^+])\+\+([^+\s](?:[^+]*[^+\s])?)\+\+$/u, len: 2, mark: 'u' },
  { re: /(?:^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/u, len: 2, mark: 's' },
  { re: /(?:^|[^=])==([^=\s](?:[^=]*[^=\s])?)==$/u, len: 2, mark: 'mark' },
  { re: /(?:^|[^`])`([^`]+)`$/u, len: 1, mark: 'code' },
  { re: new RegExp(`(?:^|${NOT_WORD.slice(0, -1)}*])\\*([^*\\s](?:[^*]*[^*\\s])?)\\*$`, 'u'), len: 1, mark: 'em' },
  { re: new RegExp(`(?:^|${NOT_WORD})_([^_\\s](?:[^_]*[^_\\s])?)_$`, 'u'), len: 1, mark: 'em' },
];

/* =====================================================================
   The editor
   ===================================================================== */

export function createRichEditor(container, options = {}) {
  const opts = { ...options };
  const doc = container?.ownerDocument || document;
  const win = doc.defaultView || globalThis;
  const el = doc.createElement('div');
  el.className = 'rt';
  el.setAttribute('role', 'textbox');
  el.setAttribute('aria-multiline', 'true');
  el.setAttribute('aria-label', opts.ariaLabel || opts.placeholder || 'Nội dung ghi chú');
  el.setAttribute('data-placeholder', opts.placeholder || 'Bắt đầu viết…');
  el.setAttribute('spellcheck', 'true');
  el.setAttribute('translate', 'no');
  container?.appendChild(el);

  let readOnly = !!opts.readOnly;
  let destroyed = false;
  let composing = false;
  let lastMd = '';
  let changeTimer = 0;
  let selRaf = 0;
  let dragging = false;
  let lastSaved = null; // last selection inside the editor (for toolbar exec)
  let slashAnchor = null; // { node, off }
  let caseCycle = null; // { saved, mode }
  let exitMark = null; // mark element just closed by an input rule: next typed text goes after it

  /* ----- history ----- */
  let stack = [];
  let index = -1;
  let lastKind = null;
  let lastTime = 0;
  let lastData = '';
  let preSel = null;

  const listeners = [];
  const on = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    listeners.push(() => target.removeEventListener(type, fn, o));
  };

  const sel = () => (doc.getSelection ? doc.getSelection() : win.getSelection());
  const inEditor = (n) => !!n && (n === el || el.contains(n));
  const range = () => {
    const s = sel();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    return inEditor(r.startContainer) && inEditor(r.endContainer) ? r : null;
  };
  const setCaret = (node, off) => {
    const s = sel();
    if (!s) return;
    const r = doc.createRange();
    r.setStart(node, off);
    r.collapse(true);
    s.removeAllRanges();
    s.addRange(r);
  };
  const setRange = (r) => {
    const s = sel();
    if (!s || !r) return;
    s.removeAllRanges();
    s.addRange(r);
  };
  const caretAt = (block, k) => {
    const [n, o] = pointAt(block, k);
    setCaret(n, o);
  };
  const caretEnd = (block) => caretAt(block, textOf(block).length);
  const blockOf = (node) => {
    let n = node && node.nodeType === 1 ? node : node?.parentNode;
    while (n && n !== el) {
      if (n.nodeType === 1 && LEAF_TAGS.has(n.tagName)) return n;
      n = n.parentNode;
    }
    return null;
  };
  const topOf = (node) => {
    let n = node;
    while (n && n.parentNode !== el) n = n.parentNode;
    return n || null;
  };
  const curBlock = () => {
    const r = range();
    return r ? blockOf(r.startContainer) : null;
  };
  const newP = () => {
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    return p;
  };
  const fill = (block) => {
    if (!block || !block.isConnected) return;
    if (block.tagName === 'PRE') {
      const code = block.querySelector('code') || block;
      if (!code.textContent && !code.querySelector('br')) code.appendChild(doc.createElement('br'));
      return;
    }
    if (!ownNodes(block).length) {
      // an empty text node would trap the caret where Chrome can't type: drop it
      const walker = doc.createTreeWalker(block, 4);
      const empties = [];
      for (let t = walker.nextNode(); t; t = walker.nextNode()) if (!t.data) empties.push(t);
      empties.forEach((t) => t.remove());
      removeEmptyInline(block);
      if (![...block.childNodes].some((c) => isEl(c, 'BR'))) {
        const ref = [...block.childNodes].find(isList) || null;
        block.insertBefore(doc.createElement('br'), ref);
      }
    }
  };
  const rename = (b, tag) => {
    if (b.tagName === tag.toUpperCase()) return b;
    const n = doc.createElement(tag);
    while (b.firstChild) n.appendChild(b.firstChild);
    b.replaceWith(n);
    return n;
  };
  const removeEmptyInline = (block) => {
    for (const m of [...block.querySelectorAll('strong,em,u,s,mark,code:not(pre > code),a,span:not([contenteditable]):not([data-rt-marker])')]) {
      if (!m.textContent && !m.querySelector('br,img')) m.remove();
    }
  };
  const pruneContainers = (n) => {
    while (n && n !== el && n.isConnected) {
      const t = n.tagName;
      const empty =
        ((t === 'UL' || t === 'OL') && !n.querySelector('li')) ||
        (t === 'BLOCKQUOTE' && !n.children.length && !n.textContent.trim()) ||
        ((t === 'TBODY' || t === 'THEAD' || t === 'TR') && !n.children.length);
      if (!empty) break;
      const p = n.parentNode;
      n.remove();
      n = p;
    }
    if (n?.tagName === 'TABLE' && !n.querySelector('td,th')) n.remove();
  };

  /* ----- markdown ----- */

  function currentMd() {
    let root = el;
    if (el.querySelector('[data-uploading],[data-rt-marker]')) {
      root = el.cloneNode(true);
      root.querySelectorAll('[data-uploading],[data-rt-marker]').forEach((n) => n.remove());
    }
    try {
      return htmlToMd(root);
    } catch (err) {
      console.error('[rich editor] htmlToMd failed', err);
      return lastMd;
    }
  }

  function render(md) {
    let h = '';
    try {
      h = mdToHtml(String(md ?? ''), { editable: true });
    } catch (err) {
      console.error('[rich editor] mdToHtml failed', err);
    }
    el.innerHTML = h; // mdToHtml output is trusted (built from escaped text only)
    structure();
  }

  /** Structural invariants: at least one <p>, a typing spot after trailing figures/hr/tables, no stray inline at root. */
  function structure() {
    let run = null;
    for (const c of [...el.childNodes]) {
      const inline = isText(c) ? !!c.data.trim() : isEl(c) && !ROOT_BLOCKS.has(c.tagName) && !(isUi(c) && c.tagName === 'FIGURE');
      if (inline) {
        if (!run) {
          run = doc.createElement('p');
          el.insertBefore(run, c);
        }
        run.appendChild(c);
        continue;
      }
      run = null;
      if (isText(c) && !c.data.trim()) c.remove();
      else if (isEl(c, 'DIV')) {
        if ([...c.children].some((k) => ROOT_BLOCKS.has(k.tagName))) c.replaceWith(...c.childNodes);
        else rename(c, 'p');
      } else if (isEl(c, 'BR')) c.remove();
    }
    const last = el.lastElementChild;
    if (!last || ['FIGURE', 'HR', 'TABLE'].includes(last.tagName) || isUi(last)) el.appendChild(newP());
    for (const b of el.querySelectorAll('p:empty,h1:empty,h2:empty,h3:empty,li:empty,td:empty,th:empty')) b.appendChild(doc.createElement('br'));
  }

  /** Cheap clean-up after native editing: browser-made tags, stray text, placeholder <br>s. */
  function normalize() {
    let saved;
    const save = () => {
      if (saved === undefined) saved = commands.saveSelection(el);
    };
    const junk = [...el.querySelectorAll('b,i,strike,del,font,div,span:not([class]):not([contenteditable]):not([data-rt-marker])')]
      .filter((j) => !j.parentElement?.closest('[contenteditable="false"]'));
    if (junk.length) {
      save();
      for (const j of junk) {
        if (!j.isConnected) continue;
        const t = j.tagName;
        if (t === 'B') rename(j, 'strong');
        else if (t === 'I') rename(j, 'em');
        else if (t === 'STRIKE' || t === 'DEL') rename(j, 's');
        else if (t === 'DIV') {
          if (j.parentNode === el && ![...j.children].some((k) => ROOT_BLOCKS.has(k.tagName))) rename(j, 'p');
          else j.replaceWith(...j.childNodes);
        } else j.replaceWith(...j.childNodes);
      }
    }
    const strayRoot = [...el.childNodes].some(
      (c) => (isText(c) && c.data.trim()) || (isEl(c) && !ROOT_BLOCKS.has(c.tagName)),
    );
    const noBlock = !el.firstElementChild;
    const bqStray = [...el.querySelectorAll('blockquote')].some((bq) =>
      [...bq.childNodes].some((c) => (isText(c) && c.data.trim()) || (isEl(c) && !ROOT_BLOCKS.has(c.tagName))),
    );
    if (strayRoot || noBlock || bqStray) {
      save();
      for (const bq of el.querySelectorAll('blockquote')) {
        let run = null;
        for (const c of [...bq.childNodes]) {
          if ((isText(c) && c.data.trim()) || (isEl(c) && !ROOT_BLOCKS.has(c.tagName))) {
            if (!run) {
              run = doc.createElement('p');
              bq.insertBefore(run, c);
            }
            run.appendChild(c);
          } else run = null;
        }
      }
      structure();
    }
    // a trailing <br> after text is only a placeholder; a lone one is needed
    const b = curBlock();
    if (b && b.tagName !== 'PRE') {
      const kids = [...b.childNodes].filter((c) => !isList(c));
      const lastKid = kids[kids.length - 1];
      if (isEl(lastKid, 'BR') && kids.length > 1) {
        const prev = lastKid.previousSibling;
        if (prev && !isEl(prev, 'BR') && !(isText(prev) && !prev.data) && !isUi(prev)) {
          // only when the caret is not right after it
          const r = range();
          if (!r || !(r.startContainer === b && r.startOffset > indexOf(lastKid))) {
            save();
            lastKid.remove();
          }
        }
      }
    }
    if (!el.firstElementChild) {
      save();
      el.appendChild(newP());
    }
    if (saved !== undefined && saved) commands.restoreSelection(el, saved);
  }

  function updateEmpty() {
    const kids = el.children;
    const empty = kids.length === 0 || (kids.length === 1 && kids[0].tagName === 'P' && isBlank(kids[0]) && !kids[0].querySelector('img'));
    el.classList.toggle('is-empty', empty);
  }

  /* ----- change + history ----- */

  function scheduleChange() {
    if (destroyed) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(flush, CHANGE_MS);
  }

  function flush() {
    clearTimeout(changeTimer);
    changeTimer = 0;
    if (destroyed && !el) return;
    const md = currentMd();
    if (md !== lastMd) {
      lastMd = md;
      try {
        opts.onChange?.(md);
      } catch (err) {
        console.error(err);
      }
    }
  }

  /* Selection snapshot: [leaf index, text offset] for anchor/focus — cheap (no
     serialisation), valid as long as the block structure is the same (history restore). */
  const leaves = () => [...el.querySelectorAll('p,h1,h2,h3,h4,h5,h6,pre,li,td,th')];
  const saveSel = () => {
    const s = sel();
    if (!s || !s.rangeCount || !inEditor(s.anchorNode) || !inEditor(s.focusNode)) return null;
    const ls = leaves();
    if (!ls.length) return null;
    const at = (node, off) => {
      const b = blockOf(node);
      if (b) return [ls.indexOf(b), offsetIn(b, node, off)];
      for (let i = 0; i < ls.length; i++) if (atOrAfter(node, off, ls[i])) return [i, 0];
      return [ls.length - 1, textOf(ls[ls.length - 1]).length];
    };
    return { a: at(s.anchorNode, s.anchorOffset), f: at(s.focusNode, s.focusOffset) };
  };
  const restoreSel = (p) => {
    if (!p) return false;
    const ls = leaves();
    if (!ls.length) return false;
    const pt = ([i, o]) => {
      const b = ls[Math.max(0, Math.min(i, ls.length - 1))];
      return pointAt(b, Math.min(o, textOf(b).length));
    };
    const [an, ao] = pt(p.a);
    const [fn, fo] = pt(p.f);
    const s = sel();
    if (!s) return false;
    if (s.setBaseAndExtent) s.setBaseAndExtent(an, ao, fn, fo);
    else {
      const r = doc.createRange();
      r.setStart(an, ao);
      r.collapse(true);
      s.removeAllRanges();
      s.addRange(r);
    }
    return true;
  };
  const sameSel = (x, y) => !!x && !!y && x.a[0] === y.a[0] && x.a[1] === y.a[1] && x.f[0] === y.f[0] && x.f[1] === y.f[1];

  /** History snapshot: the editor DOM without transient UI (upload placeholders, figure selection). */
  function snapshotHtml() {
    if (!el.querySelector('[data-uploading],[data-rt-marker],.is-selected,[aria-selected]')) return el.innerHTML;
    const c = el.cloneNode(true);
    c.querySelectorAll('[data-uploading],[data-rt-marker]').forEach((n) => n.remove());
    c.querySelectorAll('.is-selected,[aria-selected]').forEach((n) => {
      n.classList.remove('is-selected');
      n.removeAttribute('aria-selected');
    });
    return c.innerHTML;
  }

  function record(kind = 'cmd', data = '') {
    const md = snapshotHtml();
    const top = stack[index];
    const s = saveSel();
    if (top && top.html === md) {
      if (s) top.sel = s;
      preSel = null;
      if (kind === 'type' && lastKind === 'type') {
        lastTime = Date.now();
        lastData = data || '';
      }
      return false;
    }
    const now = Date.now();
    const boundary = /\s/.test(lastData) && !/\s/.test(data);
    if (top && index > 0 && top.open && kind === 'type' && lastKind === 'type' && now - lastTime < COALESCE_MS && !boundary) {
      top.html = md;
      top.sel = s;
    } else {
      if (top && preSel) top.sel = preSel;
      stack.length = index + 1;
      stack.push({ html: md, sel: s, open: kind === 'type' });
      while (stack.length > HISTORY_MAX) stack.shift();
      index = stack.length - 1;
    }
    lastKind = kind;
    lastTime = now;
    lastData = data || '';
    preSel = null;
    return true;
  }

  function resetHistory() {
    stack = [{ html: snapshotHtml(), sel: null, open: false }];
    index = 0;
    lastKind = null;
    preSel = null;
  }

  function restore(entry) {
    closeSlash();
    el.innerHTML = entry.html; // our own sanitised DOM snapshot
    structure();
    entry.html = snapshotHtml();
    if (entry.sel) restoreSel(entry.sel);
    else {
      const l = lastLeafIn(el.lastElementChild) || firstLeafIn(el.firstElementChild);
      if (l) caretEnd(l);
    }
    lastKind = null;
    updateEmpty();
    scheduleChange();
    emit('rt:render');
    emitSelection();
  }

  function undo() {
    if (readOnly) return false;
    record('cmd');
    if (index <= 0) return false;
    index--;
    restore(stack[index]);
    return true;
  }

  function redo() {
    if (readOnly || index >= stack.length - 1) return false;
    index++;
    restore(stack[index]);
    return true;
  }

  function afterMutation(kind = 'cmd', data = '') {
    normalize();
    record(kind, data);
    updateEmpty();
    scheduleChange();
    emitSelection();
  }

  const emit = (type, detail, cancelable = false) => {
    const ev = new CustomEvent(type, { bubbles: true, cancelable, detail });
    el.dispatchEvent(ev);
    return ev;
  };

  function emitSelection() {
    if (!opts.onSelectionChange || destroyed) return;
    // trailing debounce: activeState walks the document, keep it off the keystroke path
    clearTimeout(selRaf);
    selRaf = setTimeout(() => {
      selRaf = 0;
      if (destroyed) return;
      try {
        opts.onSelectionChange(state());
      } catch (err) {
        console.error(err);
      }
    }, 60);
  }

  function state() {
    try {
      return commands.activeState(el);
    } catch {
      return { bold: false, italic: false, underline: false, strike: false, mark: false, code: false, link: false, block: 'p', list: null };
    }
  }

  /* ----- generic editing helpers ----- */

  /** Moves everything from the caret to the end of the block's own content into a new block. */
  function splitBlock(block, r, tag = block.tagName.toLowerCase()) {
    const after = doc.createRange();
    after.setStart(r.startContainer, r.startOffset);
    const firstList = [...block.childNodes].find(isList);
    if (firstList) after.setEndBefore(firstList);
    else after.setEnd(block, block.childNodes.length);
    const frag = after.extractContents();
    const nb = doc.createElement(tag);
    if (block.tagName === 'LI' && block.hasAttribute('data-checked')) {
      nb.setAttribute('data-checked', 'false');
      nb.appendChild(commands.makeCheckbox(doc, false));
      // the checkbox must not travel with the text
      frag.querySelectorAll?.('[contenteditable="false"]').forEach((n) => n.remove());
    }
    nb.appendChild(frag);
    if (block.tagName === 'LI') for (const l of [...block.childNodes].filter(isList)) nb.appendChild(l);
    if (block.tagName === 'LI' && block.hasAttribute('data-checked') && ![...block.children].some(isUi)) {
      block.insertBefore(commands.makeCheckbox(doc, block.getAttribute('data-checked') === 'true'), block.firstChild);
    }
    removeEmptyInline(block);
    removeEmptyInline(nb);
    trimLeadingEmptyText(nb);
    block.after(nb);
    fill(block);
    fill(nb);
    return nb;
  }

  function trimLeadingEmptyText(b) {
    for (const t of [...b.childNodes]) if (isText(t) && !t.data) t.remove();
  }

  /** Deletes a (possibly multi-block) selection, merging the boundary blocks. */
  function deleteSelection() {
    const r = range();
    if (!r || r.collapsed) return;
    const sb = blockOf(r.startContainer);
    const eb = blockOf(r.endContainer);
    // the whole document selected (Ctrl+A) → start over from one empty paragraph
    const first = firstLeafIn(el.firstElementChild);
    const last = lastLeafIn(el.lastElementChild);
    const fromStart = r.startContainer === el ? !el.childNodes[r.startOffset - 1] : sb === first && offsetIn(sb, r.startContainer, r.startOffset) === 0 && !first.previousElementSibling && topOf(first) === el.firstElementChild;
    const toEnd = r.endContainer === el ? r.endOffset >= el.childNodes.length : eb && eb === last && offsetIn(eb, r.endContainer, r.endOffset) >= textOf(eb).length;
    if (fromStart && toEnd && !el.querySelector('[data-uploading]')) {
      el.textContent = '';
      const p = newP();
      el.appendChild(p);
      caretAt(p, 0);
      return;
    }
    r.deleteContents();
    const s = sel();
    if (sb && eb && sb !== eb && sb.isConnected && eb.isConnected) {
      mergeBlocks(sb, eb);
    } else {
      if (sb && sb.isConnected) {
        removeEmptyInline(sb);
        fill(sb);
      }
      if (s && s.rangeCount) s.getRangeAt(0).collapse(true);
    }
    for (const c of [...el.querySelectorAll('ul,ol,blockquote,tbody,tr')]) pruneContainers(c);
    if (!el.firstElementChild) {
      const p = newP();
      el.appendChild(p);
      caretAt(p, 0);
    }
  }

  /** Appends source's own content to target (text blocks), removes source; caret at the seam. */
  function mergeBlocks(target, source) {
    const k = textOf(target).length;
    // drop target's placeholder <br>
    const tk = [...target.childNodes].filter((c) => !isList(c));
    if (isEl(tk[tk.length - 1], 'BR')) tk[tk.length - 1].remove();
    if (target.tagName === 'PRE') {
      const code = target.querySelector('code') || target;
      const add = textOf(source);
      if (add) code.appendChild(doc.createTextNode(add));
    } else {
      const ref = [...target.childNodes].find(isList) || null;
      const kids = [...source.childNodes].filter((c) => !isList(c) && !isUi(c));
      if (isEl(kids[kids.length - 1], 'BR')) kids.pop();
      for (const c of kids) target.insertBefore(c, ref);
    }
    const nested = [...source.childNodes].filter(isList);
    const parent = source.parentNode;
    if (nested.length) {
      if (target.tagName === 'LI') nested.forEach((n) => target.appendChild(n));
      else if (source.tagName === 'LI') source.replaceWith(...nested.flatMap((n) => [...n.children]));
      else source.replaceWith(...nested);
    }
    if (source.isConnected) source.remove();
    pruneContainers(parent);
    removeEmptyInline(target);
    target.normalize();
    fill(target);
    caretAt(target, k);
  }

  function insertTextAtCaret(text) {
    const r = range();
    if (!r) return;
    if (!r.collapsed) r.deleteContents();
    let node = r.startContainer;
    let off = r.startOffset;
    if (!isText(node)) {
      const t = doc.createTextNode('');
      const ref = node.childNodes[off] || null;
      // replace a lone placeholder <br>
      node.insertBefore(t, ref);
      node = t;
      off = 0;
    }
    node.insertData(off, text);
    setCaret(node, off + text.length);
    const b = blockOf(node);
    if (b) {
      const kids = [...b.childNodes].filter((c) => !isList(c));
      if (kids.length > 1 && isEl(kids[kids.length - 1], 'BR') && b.tagName !== 'PRE' && !isEl(kids[kids.length - 2], 'BR')) kids[kids.length - 1].remove();
    }
  }

  /* ----- Enter ----- */

  function handleEnter(shift) {
    if (!range()) return;
    if (!range().collapsed) deleteSelection();
    const r = range();
    if (!r) return;
    let block = blockOf(r.startContainer);
    if (!block) {
      // caret between root blocks → new paragraph there
      const p = newP();
      const ref = r.startContainer === el ? el.childNodes[r.startOffset] || null : topOf(r.startContainer)?.nextSibling || null;
      el.insertBefore(p, ref);
      caretAt(p, 0);
      return;
    }
    if (block.tagName === 'PRE') return enterInCode(block, r, shift);
    if (shift) return insertBr(r);
    if (block.tagName === 'TD' || block.tagName === 'TH') return cellBelow(block);
    if (block.tagName === 'LI') {
      if (isBlank(block) && !block.querySelector('ul,ol')) {
        commands.outdent(el); // nested → one level up; top level → paragraph
        const b = curBlock();
        if (b) fill(b);
        return;
      }
      const nb = splitBlock(block, r);
      caretAt(nb, 0);
      return;
    }
    const bq = block.parentElement?.tagName === 'BLOCKQUOTE' ? block.parentElement : null;
    if (bq && isBlank(block)) return exitQuote(block, bq);
    if (block.tagName === 'P' && block.parentNode === el) {
      const m = /^(```|~~~)([\w+#.-]*)$/.exec(textOf(block).trim());
      if (m) {
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        if (m[2]) code.setAttribute('data-lang', m[2]);
        code.appendChild(doc.createElement('br'));
        pre.appendChild(code);
        block.replaceWith(pre);
        if (!pre.nextElementSibling) pre.after(newP());
        setCaret(code, 0);
        return;
      }
    }
    if (HEADING_RE.test(block.tagName)) {
      if (isBlank(block)) {
        const p = rename(block, 'p');
        caretAt(p, 0);
        return;
      }
      const off = offsetIn(block, r.startContainer, r.startOffset);
      const len = textOf(block).length;
      if (off >= len) {
        const p = newP();
        block.after(p);
        caretAt(p, 0);
        return;
      }
      if (off === 0) {
        block.before(newP());
        caretAt(block, 0);
        return;
      }
    }
    const nb = splitBlock(block, r);
    caretAt(nb, 0);
  }

  function insertBr(r) {
    const br = doc.createElement('br');
    r.insertNode(br);
    const block = blockOf(br);
    // a <br> at the very end needs a second one to render the empty line
    let n = br.nextSibling;
    while (isText(n) && !n.data) n = n.nextSibling;
    if (!n || isList(n)) br.after(doc.createElement('br'));
    const parent = br.parentNode;
    setCaret(parent, indexOf(br) + 1);
    if (block) removeEmptyInline(block);
  }

  function enterInCode(pre, r, shift) {
    const code = pre.querySelector('code') || pre;
    const text = code.textContent;
    const off = offsetIn(pre, r.startContainer, r.startOffset);
    const before = text.slice(0, off);
    const after = text.slice(off);
    if (!shift && (after === '' || after === '\n') && before.endsWith('\n\n')) {
      // third Enter on empty lines at the end leaves the code block
      code.textContent = before.replace(/\n+$/, '');
      if (!code.textContent) code.appendChild(doc.createElement('br'));
      const p = newP();
      pre.after(p);
      caretAt(p, 0);
      return;
    }
    const atEnd = after === '' || after === '\n';
    const ins = atEnd && !after ? '\n\n' : '\n';
    code.textContent = before + ins + after;
    const t = code.firstChild;
    setCaret(t, off + 1);
  }

  function exitCode(pre) {
    const code = pre.querySelector('code') || pre;
    code.textContent = code.textContent.replace(/\n+$/, '');
    if (!code.textContent) code.appendChild(doc.createElement('br'));
    let next = pre.nextElementSibling;
    if (!next || !firstLeafIn(next)) {
      next = newP();
      pre.after(next);
    }
    caretAt(firstLeafIn(next), 0);
  }

  function exitQuote(p, bq) {
    const after = [];
    for (let n = p.nextSibling; n; n = n.nextSibling) after.push(n);
    bq.after(p);
    if (after.some(isEl)) {
      const bq2 = doc.createElement('blockquote');
      after.forEach((n) => bq2.appendChild(n));
      p.after(bq2);
    }
    if (!bq.children.length) bq.remove();
    fill(p);
    caretAt(p, 0);
  }

  function cellBelow(cell) {
    const table = cell.closest('table');
    const rows = [...table.querySelectorAll('tr')];
    const ri = rows.indexOf(cell.parentNode);
    const ci = [...cell.parentNode.children].indexOf(cell);
    const nextRow = rows[ri + 1];
    if (nextRow && nextRow.children[ci]) {
      caretEnd(nextRow.children[ci]);
      return;
    }
    let next = table.nextElementSibling;
    if (!next || !firstLeafIn(next)) {
      next = newP();
      table.after(next);
    }
    caretAt(firstLeafIn(next), 0);
  }

  function moveCell(cell, dir) {
    const table = cell.closest('table');
    const cells = [...table.querySelectorAll('th,td')];
    let i = cells.indexOf(cell) + dir;
    if (i < 0) return;
    if (i >= cells.length) {
      const lastRow = [...table.querySelectorAll('tr')].pop();
      const tr = doc.createElement('tr');
      for (let k = 0; k < lastRow.children.length; k++) tr.appendChild(doc.createElement('td')).appendChild(doc.createElement('br'));
      (table.querySelector('tbody') || table.appendChild(doc.createElement('tbody'))).appendChild(tr);
      caretAt(tr.firstElementChild, 0);
      return;
    }
    const target = cells[i];
    const s = sel();
    const rr = doc.createRange();
    rr.selectNodeContents(target);
    s.removeAllRanges();
    s.addRange(rr);
    if (isBlank(target)) caretAt(target, 0);
  }

  /* ----- Backspace / Delete at block edges ----- */

  function backspaceAtStart(b) {
    if (b.tagName === 'TD' || b.tagName === 'TH') return;
    if (b.tagName === 'LI') {
      commands.outdent(el);
      const nb = curBlock();
      if (nb) fill(nb);
      return;
    }
    if (HEADING_RE.test(b.tagName)) {
      const k = saveSel();
      rename(b, 'p');
      if (k) restoreSel(k);
      return;
    }
    if (b.tagName === 'PRE') {
      const k = saveSel();
      commands.setBlock(el, 'code'); // toggles the code block back to paragraphs
      if (k) restoreSel(k);
      return;
    }
    const parent = b.parentNode;
    if (parent.tagName === 'BLOCKQUOTE' && b === parent.firstElementChild) {
      exitQuoteStart(b, parent);
      return;
    }
    if (parent !== el && parent.tagName !== 'BLOCKQUOTE') {
      // e.g. p inside li
      const prevLeaf = b.previousElementSibling && lastLeafIn(b.previousElementSibling);
      if (prevLeaf) mergeBlocks(prevLeaf, b);
      return;
    }
    let prev = b.previousElementSibling;
    if (!prev) {
      if (parent === el && isBlank(b) && b.nextElementSibling && firstLeafIn(b.nextElementSibling)) {
        const next = b.nextElementSibling;
        b.remove();
        caretAt(firstLeafIn(next), 0);
      }
      return;
    }
    if (prev.tagName === 'HR' || (prev.tagName === 'FIGURE' && !prev.hasAttribute('data-uploading'))) {
      prev.remove();
      return;
    }
    if (prev.tagName === 'FIGURE') return;
    const target = lastLeafIn(prev);
    if (!target) return;
    if (prev.tagName === 'TABLE') {
      if (isBlank(b)) b.remove();
      caretEnd(target);
      return;
    }
    if (isBlank(b)) {
      b.remove();
      caretEnd(target);
      return;
    }
    mergeBlocks(target, b);
  }

  function exitQuoteStart(p, bq) {
    bq.before(p);
    if (!bq.children.length) bq.remove();
    caretAt(p, 0);
  }

  function nextTarget(b) {
    if (b.tagName === 'LI') {
      const sub = [...b.children].find(isList);
      if (sub && sub.firstElementChild) return { leaf: firstLeafIn(sub.firstElementChild) };
    }
    let n = b;
    while (n.parentNode !== el && !n.nextElementSibling) n = n.parentNode;
    const next = n.nextElementSibling;
    if (!next) return null;
    if (n.parentNode === el) {
      if (next.tagName === 'HR' || next.tagName === 'FIGURE') return { atom: next };
      if (next.tagName === 'TABLE') return null;
    }
    const leaf = firstLeafIn(next);
    return leaf ? { leaf } : null;
  }

  function deleteAtEnd(b) {
    if (b.tagName === 'TD' || b.tagName === 'TH') return;
    if (b.tagName === 'PRE') return;
    const t = nextTarget(b);
    if (!t) return;
    if (t.atom) {
      if (!t.atom.hasAttribute('data-uploading')) t.atom.remove();
      return;
    }
    if (isBlank(b) && b.parentNode === el && b.tagName === 'P') {
      b.remove();
      caretAt(t.leaf, 0);
      return;
    }
    if (t.leaf.tagName === 'TD' || t.leaf.tagName === 'TH') return;
    mergeBlocks(b, t.leaf);
  }

  /* ----- task checkboxes ----- */

  function checkboxTarget(t) {
    const ui = t?.closest?.('[contenteditable="false"], input[type="checkbox"]');
    if (!ui || !el.contains(ui)) return null;
    const li = ui.parentElement;
    return li?.tagName === 'LI' && li.hasAttribute('data-checked') ? ui : null;
  }

  function toggleTask(li) {
    const now = li.getAttribute('data-checked') === 'true' ? 'false' : 'true';
    li.setAttribute('data-checked', now);
    for (const c of li.children) {
      if (!isUi(c)) continue;
      if (c.hasAttribute('aria-checked')) c.setAttribute('aria-checked', now);
      if (c.tagName === 'INPUT') c.checked = now === 'true';
    }
    record('cmd');
    scheduleChange();
    emitSelection();
  }

  /* ----- input rules ----- */

  function applyInputRules(data) {
    const r = range();
    if (!r || !r.collapsed) return false;
    const node = r.startContainer;
    if (!isText(node)) return false;
    const block = blockOf(node);
    if (!block || block.tagName === 'PRE' || node.parentElement?.closest('code')) return false;
    const off = r.startOffset;

    data = String(data).slice(-1);
    // block rules: "# ", "- ", "1. ", "[] ", "> " at the start of a top-level paragraph
    if (data === ' ' || data === ' ') {
      const before = textOf(block).slice(0, offsetIn(block, node, off)).replace(/ /g, ' ');
      if (before.endsWith(' ')) {
        const marker = before.slice(0, -1);
        const rule = BLOCK_RULES.find(([re]) => re.test(marker));
        const topP = block.tagName === 'P' && block.parentNode === el;
        const inLi = block.tagName === 'LI' && /task/.test(rule?.[1] || '');
        if (rule && (topP || inLi)) {
          const del = doc.createRange();
          const [sn, so] = pointAt(block, 0);
          del.setStart(sn, so);
          del.setEnd(node, off);
          del.deleteContents();
          removeEmptyInline(block);
          fill(block);
          caretAt(block, 0);
          const kind = rule[1];
          if (/^h[123]$|^quote$/.test(kind)) commands.setBlock(el, kind);
          else if (kind === 'ul' || kind === 'ol') commands.toggleList(el, kind);
          else if (inLi) {
            const list = block.parentNode;
            if (list.getAttribute('data-type') !== 'task') commands.toggleList(el, 'task');
            if (kind === 'task-done') curBlock()?.closest('li')?.setAttribute('data-checked', 'true');
          } else {
            commands.toggleList(el, 'task');
            if (kind === 'task-done') {
              const li = curBlock()?.closest('li');
              if (li) {
                li.setAttribute('data-checked', 'true');
                li.querySelector('[aria-checked]')?.setAttribute('aria-checked', 'true');
              }
            }
          }
          const nb = curBlock();
          if (nb) fill(nb);
          return true;
        }
      }
    }

    // "---" → divider
    if (data === '-' && block.tagName === 'P' && block.parentNode === el && textOf(block) === '---') {
      const hr = doc.createElement('hr');
      let next = block.nextElementSibling;
      block.replaceWith(hr);
      if (!next || !firstLeafIn(next) || !isBlank(firstLeafIn(next))) {
        next = newP();
        hr.after(next);
      }
      caretAt(firstLeafIn(next), 0);
      return true;
    }

    // inline marks: **x** ++x++ ~~x~~ ==x== `x` *x* _x_
    if (!'*_~=`+'.includes(data)) return false;
    const textBefore = node.data.slice(0, off).replace(/ /g, ' ');
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(textBefore);
      if (!m) continue;
      const inner = m[1];
      const full = inner.length + rule.len * 2;
      const start = off - full;
      if (start < 0) continue;
      // don't nest a mark inside the same mark
      if (node.parentElement?.closest(rule.mark === 'strong' ? 'strong,b' : rule.mark)) continue;
      const rest = node.splitText(off);
      const mid = node.splitText(start);
      const wrap = doc.createElement(rule.mark);
      wrap.textContent = inner;
      mid.replaceWith(wrap);
      if (!node.data) node.remove();
      // the caret goes after the mark, outside it. Chrome would move a caret at that
      // boundary back into the mark, so the next insertText is placed explicitly.
      if (!rest.data) {
        const p = rest.parentNode;
        const i = indexOf(rest);
        rest.remove();
        setCaret(p, i);
      } else setCaret(rest, 0);
      exitMark = wrap;
      return true;
    }
    return false;
  }

  /* ----- slash menu ----- */

  const slash = createSlashMenu({ doc, onPick: (item) => runSlash(item) });

  function caretRect() {
    const r = range();
    if (!r) return null;
    let rect = r.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height && !rect.left && !rect.top)) {
      const b = blockOf(r.startContainer);
      rect = b?.getBoundingClientRect?.() || el.getBoundingClientRect();
    }
    return rect;
  }

  function maybeOpenSlash() {
    const r = range();
    if (!r || !r.collapsed || !isText(r.startContainer)) return;
    const node = r.startContainer;
    const off = r.startOffset;
    if (node.data[off - 1] !== '/') return;
    const block = blockOf(node);
    if (!block || block.tagName === 'PRE' || node.parentElement?.closest('code')) return;
    const k = offsetIn(block, node, off);
    const before = textOf(block).slice(0, k - 1);
    if (before && !/[\s ]$/.test(before)) return;
    slashAnchor = { node, off: off - 1 };
    slash.open(caretRect());
    el.setAttribute('aria-controls', slash.id);
    el.setAttribute('aria-haspopup', 'listbox');
    el.setAttribute('aria-expanded', 'true');
    syncSlashAria();
  }

  function syncSlashAria() {
    const id = slash.activeId();
    if (id) el.setAttribute('aria-activedescendant', id);
    else el.removeAttribute('aria-activedescendant');
  }

  function closeSlash() {
    if (slash.isOpen()) slash.close();
    slashAnchor = null;
    el.removeAttribute('aria-activedescendant');
    el.removeAttribute('aria-expanded');
  }

  function slashQuery() {
    const r = range();
    if (!slashAnchor || !r || !r.collapsed) return null;
    const { node, off } = slashAnchor;
    if (r.startContainer !== node || !node.isConnected || node.data[off] !== '/' || r.startOffset <= off) return null;
    return node.data.slice(off + 1, r.startOffset);
  }

  function updateSlash() {
    const q = slashQuery();
    if (q == null || q.length > 30 || /\s\s/.test(q)) return closeSlash();
    const n = slash.filter(q);
    if (!n && /\s$/.test(q)) return closeSlash();
    syncSlashAria();
  }

  function runSlash(item) {
    const q = slashQuery();
    const anchor = slashAnchor;
    closeSlash();
    if (q == null || !anchor) return;
    preSel = saveSel();
    const { node, off } = anchor;
    node.deleteData(off, q.length + 1);
    setCaret(node, off);
    const b = blockOf(node);
    if (b) {
      removeEmptyInline(b);
      fill(b);
      if (isBlank(b)) caretAt(b, 0);
    }
    switch (item.id) {
      case 'h1': case 'h2': case 'h3': case 'quote': case 'code':
        commands.setBlock(el, item.id);
        break;
      case 'ul': case 'ol': case 'task':
        commands.toggleList(el, item.id);
        break;
      case 'table':
        commands.insertTable(el, 3, 3);
        break;
      case 'hr':
        commands.insertHr(el);
        break;
      case 'image':
        afterMutation('cmd');
        emit('rt:request-image', {});
        return;
      case 'record':
        afterMutation('cmd');
        emit('rt:request-record', {});
        return;
      default:
        break;
    }
    const nb = curBlock();
    if (nb) fill(nb);
    afterMutation('cmd');
  }

  /* ----- commands ----- */

  const ALIAS = {
    bold: ['toggleMark', 'bold'], italic: ['toggleMark', 'italic'], underline: ['toggleMark', 'underline'],
    strike: ['toggleMark', 'strike'], mark: ['toggleMark', 'mark'], highlight: ['toggleMark', 'mark'],
    code: ['toggleMark', 'code'], inlineCode: ['toggleMark', 'code'],
    p: ['setBlock', 'p'], paragraph: ['setBlock', 'p'], h1: ['setBlock', 'h1'], h2: ['setBlock', 'h2'],
    h3: ['setBlock', 'h3'], quote: ['setBlock', 'quote'], codeBlock: ['setBlock', 'code'], codeblock: ['setBlock', 'code'],
    ul: ['toggleList', 'ul'], bullet: ['toggleList', 'ul'], ol: ['toggleList', 'ol'], ordered: ['toggleList', 'ol'],
    task: ['toggleList', 'task'], checklist: ['toggleList', 'task'],
    hr: ['insertHr'], divider: ['insertHr'], table: ['insertTable'], link: ['setLink'], unlink: ['setLink', null],
    upper: ['transformCase', 'upper'], lower: ['transformCase', 'lower'], title: ['transformCase', 'title'],
    sentence: ['transformCase', 'sentence'], clear: ['clearFormatting'],
  };
  const READ_CMDS = new Set(['activeState', 'findAll', 'getPendingMarks', 'saveSelection', 'textBlocks', 'normalizeUrl', 'caseTransform']);

  function ensureSelection() {
    if (range()) return;
    if (lastSaved && restoreSel(lastSaved)) return;
    const l = lastLeafIn(el.lastElementChild) || firstLeafIn(el.firstElementChild);
    if (l) caretEnd(l);
  }

  function exec(name, ...args) {
    if (destroyed) return false;
    if (name === 'undo') return undo();
    if (name === 'redo') return redo();
    if (name === 'caseCycle') return cycleCase();
    if (name === 'insertMarkdown') return insertMarkdown(...args);
    let fn = name;
    let fargs = args;
    if (ALIAS[name]) {
      const [f, ...pre] = ALIAS[name];
      fn = f;
      fargs = [...pre, ...args];
    }
    const impl = commands[fn];
    if (typeof impl !== 'function') throw new Error(`Lệnh soạn thảo không tồn tại: ${name}`);
    if (READ_CMDS.has(fn)) return impl(el, ...fargs);
    if (readOnly) return false;
    if (fn !== 'replaceAll') ensureSelection();
    preSel = saveSel();
    if (fn !== 'transformCase') caseCycle = null;
    const res = impl(el, ...fargs);
    const b = curBlock();
    if (b) fill(b);
    afterMutation('cmd');
    return res;
  }

  function cycleCase() {
    if (readOnly) return false;
    ensureSelection();
    const cur = saveSel();
    const same = caseCycle && sameSel(cur, caseCycle.saved);
    let mode;
    if (same) mode = { upper: 'lower', lower: 'title', title: 'upper' }[caseCycle.mode];
    else {
      const r = range();
      let text = r ? r.toString() : '';
      if (!text) text = curBlock() ? textOf(curBlock()) : '';
      const U = text.toLocaleUpperCase('vi');
      const L = text.toLocaleLowerCase('vi');
      mode = text === U && U !== L ? 'lower' : text === L && U !== L ? 'title' : 'upper';
    }
    preSel = cur;
    commands.transformCase(el, mode);
    afterMutation('cmd');
    caseCycle = { saved: saveSel(), mode };
    return mode;
  }

  function requestLink() {
    ensureSelection();
    const saved = saveSel();
    const st = state();
    const apply = (url) => {
      if (saved) restoreSel(saved);
      const v = url == null ? null : String(url).trim();
      return exec('setLink', v || null);
    };
    const ev = emit('rt:request-link', { href: st.href || null, apply }, true);
    if (ev.defaultPrevented) return;
    const url = win.prompt?.('Địa chỉ liên kết (https://…). Để trống để bỏ liên kết:', st.href || 'https://');
    if (url == null) {
      if (saved) restoreSel(saved);
      return;
    }
    apply(url === 'https://' ? null : url);
  }

  /* ----- inserting parsed content ----- */

  function parseMd(md) {
    const box = doc.createElement('div');
    try {
      box.innerHTML = mdToHtml(String(md ?? ''), { editable: true });
    } catch (err) {
      console.error('[rich editor] mdToHtml failed', err);
    }
    return [...box.childNodes].filter((n) => isEl(n) || (isText(n) && n.data.trim()));
  }

  function placeAtEndOf(nodes) {
    const last = nodes[nodes.length - 1];
    const leaf = lastLeafIn(last);
    if (leaf && last.tagName !== 'TABLE') {
      caretEnd(leaf);
      return;
    }
    let next = last.nextElementSibling;
    if (!next || !firstLeafIn(next) || next.tagName === 'TABLE') {
      next = newP();
      last.after(next);
    }
    caretAt(firstLeafIn(next), 0);
  }

  /** Inserts dialect nodes at the caret: a single paragraph inline, otherwise as blocks. */
  function insertNodes(nodes, { inline = true } = {}) {
    if (!nodes.length) return;
    ensureSelection();
    if (range() && !range().collapsed) deleteSelection();
    const r = range();
    if (!r) return;
    const block = blockOf(r.startContainer);
    if (block?.tagName === 'PRE') {
      const text = nodes.map((n) => (isEl(n) ? n.textContent : n.data)).join('\n');
      insertTextAtCaret(text);
      return;
    }
    if (inline && nodes.length === 1 && isEl(nodes[0], 'P') && block) {
      const kids = [...nodes[0].childNodes];
      if (!kids.length) return;
      // drop the placeholder <br> of an empty block
      if (isBlank(block)) {
        for (const c of [...block.childNodes]) if (isEl(c, 'BR')) c.remove();
        const [n0, o0] = pointAt(block, 0);
        setCaret(n0, o0);
      }
      const frag = doc.createDocumentFragment();
      kids.forEach((k) => frag.appendChild(k));
      range().insertNode(frag);
      const last = kids[kids.length - 1];
      const k = offsetIn(block, last.parentNode, indexOf(last) + 1);
      block.normalize();
      removeEmptyInline(block);
      caretAt(block, k);
      // typing after pasted bold/italic text should not continue the mark
      if (isEl(last) && last.isConnected && /^(STRONG|EM|U|S|MARK|CODE|A)$/.test(last.tagName)) exitMark = last;
      return;
    }
    let before = null;
    if (!block) {
      before = r.startContainer === el ? el.childNodes[r.startOffset] || null : topOf(r.startContainer)?.nextSibling || null;
    } else {
      const top = topOf(block);
      const off = offsetIn(block, r.startContainer, r.startOffset);
      if (top === block && (block.tagName === 'P' || HEADING_RE.test(block.tagName))) {
        if (isBlank(block)) {
          before = block.nextSibling;
          block.remove();
        } else if (off === 0) before = block;
        else if (off >= textOf(block).length) before = block.nextSibling;
        else before = splitBlock(block, r);
      } else {
        const atTopStart = off === 0 && firstLeafIn(top) === block;
        before = atTopStart ? top : top.nextSibling;
      }
    }
    for (const n of nodes) {
      if (isText(n)) {
        const p = doc.createElement('p');
        p.appendChild(n);
        el.insertBefore(p, before);
      } else el.insertBefore(n, before);
    }
    const inserted = nodes.map((n) => (isText(n) ? n.parentNode : n));
    for (const n of inserted) for (const b of n.querySelectorAll?.('p:empty,li:empty,td:empty,th:empty') || []) b.appendChild(doc.createElement('br'));
    placeAtEndOf(inserted);
  }

  function insertPlainText(text) {
    const t = String(text).replace(/\r\n?/g, '\n');
    if (!t.includes('\n')) {
      insertTextAtCaret(t);
      return;
    }
    const paras = t.split(/\n{2,}/);
    const nodes = paras.map((para) => {
      const p = doc.createElement('p');
      para.split('\n').forEach((line, i) => {
        if (i) p.appendChild(doc.createElement('br'));
        if (line) p.appendChild(doc.createTextNode(line));
      });
      return p;
    });
    insertNodes(nodes);
  }

  function insertClipboard(htmlStr, text) {
    if (htmlStr && htmlHasContent(htmlStr)) {
      const clean = sanitizeHtml(htmlStr, doc);
      let md = '';
      try {
        md = htmlToMd(clean);
      } catch (err) {
        console.error('[rich editor] htmlToMd failed', err);
      }
      if (md.trim()) return insertPastedMd(md);
    }
    if (!text) return false;
    if (looksLikeMarkdown(text)) return insertPastedMd(text);
    insertPlainText(text);
    return true;
  }

  /** Is the collapsed range r right next to node (no text in between, same block)? */
  function caretBeside(r, node) {
    if (!r.collapsed || blockOf(r.startContainer) !== blockOf(node)) return false;
    const around = doc.createRange();
    around.selectNode(node);
    const t = doc.createRange();
    if (around.comparePoint(r.startContainer, r.startOffset) < 0) {
      t.setStart(r.startContainer, r.startOffset);
      t.setEndBefore(node);
    } else {
      t.setStartAfter(node);
      t.setEnd(r.startContainer, r.startOffset);
    }
    return t.toString() === '';
  }

  /**
   * Inserts pasted/dropped Markdown. With options.transformPastedMarkdown(md) the
   * insertion waits for it (e.g. copying media from other notes): a marker element
   * keeps the original position across the await, edits made meanwhile are kept.
   */
  function insertPastedMd(md) {
    const hook = opts.transformPastedMarkdown;
    if (typeof hook !== 'function') {
      insertNodes(parseMd(md));
      return true;
    }
    ensureSelection();
    if (range() && !range().collapsed) deleteSelection();
    const r = range();
    const marker = doc.createElement('span');
    marker.setAttribute('data-rt-marker', 'paste');
    if (r) r.insertNode(marker);
    else (lastLeafIn(el.lastElementChild) || el).appendChild(marker);
    Promise.resolve()
      .then(() => hook(md))
      .catch((err) => {
        console.error('[rich editor] transformPastedMarkdown failed', err);
        return md;
      })
      .then((out) => {
        if (destroyed) return;
        const live = marker.isConnected && el.contains(marker);
        // the user moved on while we waited → remember their caret with a second marker
        let userMark = null;
        const cur = range();
        if (live && cur && !caretBeside(cur, marker)) {
          userMark = doc.createElement('span');
          userMark.setAttribute('data-rt-marker', 'caret');
          const c = cur.cloneRange();
          c.collapse(false);
          c.insertNode(userMark);
        }
        if (live) {
          const at = doc.createRange();
          at.setStartBefore(marker);
          at.collapse(true);
          const parent = marker.parentNode;
          marker.remove();
          setRange(at);
          if (parent && blockOf(parent)) fill(blockOf(parent));
        }
        const text = typeof out === 'string' ? out : md;
        if (!live && !text.trim()) return;
        if (!live) ensureSelection();
        insertNodes(parseMd(text));
        if (userMark) {
          const a = doc.createRange();
          a.setStartBefore(userMark);
          a.collapse(true);
          userMark.remove();
          setRange(a);
        }
        afterMutation('cmd');
        emit('rt:render');
      });
    return true;
  }

  function insertMarkdown(md) {
    if (readOnly || destroyed) return false;
    preSel = saveSel();
    closeSlash();
    insertNodes(parseMd(md), { inline: false });
    afterMutation('cmd');
    emit('rt:render');
    return true;
  }

  /* ----- images (paste / drop) ----- */

  let uploadSeq = 0;
  function handleImageFiles(files, r) {
    const at = r || range()?.cloneRange() || null;
    if (typeof opts.onImageFiles === 'function') {
      try {
        opts.onImageFiles(files, { range: at });
      } catch (err) {
        console.error(err);
      }
      return;
    }
    const ev = emit('rt:image-files', { files, range: at }, true);
    if (ev.defaultPrevented) return;
    if (typeof opts.uploadImage !== 'function') return;
    if (r) setRange(r);
    for (const file of files) {
      const fig = doc.createElement('figure');
      fig.className = 'rt-img rt-img--uploading';
      fig.setAttribute('contenteditable', 'false');
      fig.setAttribute('data-uploading', String(++uploadSeq));
      fig.setAttribute('aria-busy', 'true');
      const msg = doc.createElement('span');
      msg.className = 'rt-img__msg';
      msg.textContent = 'Đang tải ảnh lên…';
      fig.appendChild(msg);
      insertNodes([fig], { inline: false });
      Promise.resolve()
        .then(() => opts.uploadImage(file))
        .then((res) => {
          if (destroyed || !fig.isConnected) return;
          if (!res?.url) throw new Error('Máy chủ không trả về đường dẫn ảnh.');
          const [final] = parseMd(`![](${res.url})`);
          if (!final) throw new Error('Không hiển thị được ảnh.');
          const keep = saveSel();
          fig.replaceWith(final);
          if (keep) restoreSel(keep);
          afterMutation('cmd');
          emit('rt:render');
        })
        .catch((error) => {
          if (destroyed) return;
          if (fig.isConnected) {
            fig.classList.add('rt-img--error');
            fig.removeAttribute('aria-busy');
            msg.textContent = 'Không tải được ảnh — bấm để xóa';
            fig.addEventListener('click', () => fig.remove(), { once: true });
          }
          emit('rt:upload-error', { error, file });
        });
    }
    afterMutation('cmd');
  }

  /* ----- event handlers ----- */

  function onBeforeInput(e) {
    if (readOnly) {
      e.preventDefault();
      return;
    }
    if (e.isComposing || composing) return;
    const t = e.inputType || '';
    preSel = saveSel();
    switch (t) {
      case 'historyUndo':
        e.preventDefault();
        undo();
        return;
      case 'historyRedo':
        e.preventDefault();
        redo();
        return;
      case 'formatBold': case 'formatItalic': case 'formatUnderline': case 'formatStrikeThrough': {
        e.preventDefault();
        exec({ formatBold: 'bold', formatItalic: 'italic', formatUnderline: 'underline', formatStrikeThrough: 'strike' }[t]);
        return;
      }
      case 'insertParagraph':
      case 'insertLineBreak':
        e.preventDefault();
        if (slash.isOpen() && t === 'insertParagraph' && slash.count()) {
          slash.pick();
          return;
        }
        closeSlash();
        handleEnter(t === 'insertLineBreak');
        afterMutation('cmd');
        return;
      case 'deleteContentBackward': case 'deleteWordBackward': case 'deleteSoftLineBackward': case 'deleteHardLineBackward':
      case 'deleteContentForward': case 'deleteWordForward': case 'deleteSoftLineForward': case 'deleteHardLineForward': {
        const r = range();
        if (!r) return;
        const forward = t.endsWith('Forward');
        if (!r.collapsed) {
          const sb = blockOf(r.startContainer);
          const eb = blockOf(r.endContainer);
          if (sb !== eb || !sb) {
            e.preventDefault();
            deleteSelection();
            afterMutation('cmd');
          }
          return;
        }
        const b = blockOf(r.startContainer);
        if (!b) return;
        const off = offsetIn(b, r.startContainer, r.startOffset);
        if (!forward && off === 0) {
          e.preventDefault();
          backspaceAtStart(b);
          afterMutation('cmd');
        } else if (forward && off >= textOf(b).length) {
          e.preventDefault();
          deleteAtEnd(b);
          afterMutation('cmd');
        }
        return;
      }
      case 'insertText':
      case 'insertReplacementText': {
        const data = e.data ?? e.dataTransfer?.getData?.('text/plain') ?? '';
        const r = range();
        if (!r) return;
        const crosses = !r.collapsed && blockOf(r.startContainer) !== blockOf(r.endContainer);
        let pending = {};
        try {
          pending = r.collapsed ? commands.getPendingMarks(el) : {};
        } catch { /* ignore */ }
        const hasPending = pending && Object.keys(pending).length > 0;
        if (!crosses && !hasPending && exitMark && typeAfterMark(data)) {
          e.preventDefault();
          afterInput('insertText', data);
          return;
        }
        exitMark = null;
        if (crosses || hasPending) {
          e.preventDefault();
          if (crosses) deleteSelection();
          const text = keepSpacesAtCaret(data);
          if (!commands.insertText(el, text)) insertTextAtCaret(text);
          afterInput('insertText', data);
        }
        return;
      }
      default:
    }
  }

  /** Types `data` right after exitMark when the caret sits at its end; false otherwise. */
  function typeAfterMark(data) {
    const m = exitMark;
    exitMark = null;
    const r = range();
    if (!m || !m.isConnected || !r || !r.collapsed) return false;
    const b = blockOf(m);
    if (!b || blockOf(r.startContainer) !== b) return false;
    const end = offsetIn(b, m.parentNode, indexOf(m) + 1);
    if (offsetIn(b, r.startContainer, r.startOffset) !== end) return false;
    let t = m.nextSibling;
    if (!isText(t)) {
      t = doc.createTextNode('');
      m.after(t);
    }
    const text = keepSpaces(data, m.textContent.slice(-1), t.data[0] || '');
    t.insertData(0, text);
    setCaret(t, text.length);
    return true;
  }

  /** keepSpaces() for text about to be inserted at the caret. */
  function keepSpacesAtCaret(data) {
    const r = range();
    const b = r && blockOf(r.startContainer);
    if (!b || b.tagName === 'PRE') return data;
    const txt = textOf(b);
    const off = offsetIn(b, r.startContainer, r.startOffset);
    return keepSpaces(data, txt[off - 1] || '', txt[off] || '');
  }

  function afterInput(t, data) {
    normalize();
    const typing = t === 'insertText' || t === 'insertCompositionText' || t === 'insertReplacementText' || t.startsWith('delete');
    record(typing ? 'type' : 'cmd', data || '');
    if (t === 'insertText' && data) {
      if (!slash.isOpen() && applyInputRules(data)) {
        normalize();
        record('cmd');
      } else if (data === '/' && !slash.isOpen()) maybeOpenSlash();
      else if (slash.isOpen()) updateSlash();
    } else if (slash.isOpen()) updateSlash();
    updateEmpty();
    scheduleChange();
    emitSelection();
  }

  function onInput(e) {
    if (readOnly || composing || e.isComposing) return;
    afterInput(e.inputType || '', e.data ?? null);
  }

  function onCompositionStart() {
    composing = true;
  }
  function onCompositionEnd(e) {
    composing = false;
    // the final input event of a composition still has isComposing=true in Chrome
    setTimeout(() => {
      if (!destroyed && !composing) afterInput('insertCompositionText', e.data || '');
    }, 0);
  }

  function onKeyDown(e) {
    if (destroyed) return;
    if (e.isComposing || composing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key || '').toLowerCase();
    const code = e.code || '';
    if (readOnly) {
      return;
    }
    if (slash.isOpen()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slash.move(e.key === 'ArrowDown' ? 1 : -1);
        syncSlashAria();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !mod && !e.shiftKey) {
        if (slash.count()) {
          e.preventDefault();
          slash.pick();
          return;
        }
        closeSlash();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSlash();
        return;
      }
    }
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && !e.altKey) {
      if (key === 'z' && !e.shiftKey) return handled(), undo();
      if ((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) return handled(), redo();
      if (!e.shiftKey && (key === 'b' || code === 'KeyB')) return handled(), exec('bold');
      if (!e.shiftKey && (key === 'i' || code === 'KeyI')) return handled(), exec('italic');
      if (!e.shiftKey && (key === 'u' || code === 'KeyU')) return handled(), exec('underline');
      if (e.shiftKey && code === 'KeyU') return handled(), cycleCase();
      if (e.shiftKey && code === 'KeyX') return handled(), exec('strike');
      if (e.shiftKey && code === 'KeyH') return handled(), exec('mark');
      if (!e.shiftKey && (key === 'k' || code === 'KeyK')) return handled(), requestLink();
      if (key === '\\' || code === 'Backslash') return handled(), exec('clearFormatting');
      if (e.shiftKey && code === 'Digit7') return handled(), exec('ol');
      if (e.shiftKey && code === 'Digit8') return handled(), exec('ul');
      if (e.shiftKey && code === 'Digit9') return handled(), exec('task');
      if (!e.shiftKey && (code === 'KeyF' || code === 'KeyH')) {
        const ev = emit('rt:request-find', { replace: code === 'KeyH' }, true);
        if (ev.defaultPrevented) e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        const b = curBlock();
        const li = b?.closest('li');
        if (li && li.hasAttribute('data-checked') && el.contains(li)) {
          handled();
          toggleTask(li);
          return;
        }
        if (b?.tagName === 'PRE') {
          handled();
          preSel = saveSel();
          exitCode(b);
          afterMutation('cmd');
          return;
        }
      }
    }
    if (mod && e.altKey && !e.shiftKey && /^Digit[0-3]$/.test(code)) {
      handled();
      exec(code === 'Digit0' ? 'p' : `h${code.slice(-1)}`);
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const b = curBlock();
      if (!b) return;
      if (b.tagName === 'PRE') {
        handled();
        preSel = saveSel();
        if (!e.shiftKey) insertTextAtCaret('  ');
        afterMutation('type', ' ');
        return;
      }
      const li = b.closest('li');
      if (li && el.contains(li)) {
        handled();
        exec(e.shiftKey ? 'outdent' : 'indent');
        return;
      }
      const cell = b.closest('td,th');
      if (cell) {
        handled();
        moveCell(cell, e.shiftKey ? -1 : 1);
        afterMutation('cmd');
      }
      return;
    }
    // Some engines (and tests) don't send beforeinput for Enter: handle it here as a fallback.
    if (e.key === 'Enter' && !mod && !e.altKey && typeof InputEvent === 'undefined') {
      handled();
      handleEnter(e.shiftKey);
      afterMutation('cmd');
    }
  }

  function onMouseDown(e) {
    if (checkboxTarget(e.target)) e.preventDefault(); // keep the caret where it is
  }

  function onClick(e) {
    const box = checkboxTarget(e.target);
    if (!box) return;
    e.preventDefault();
    if (readOnly) return;
    toggleTask(box.parentElement);
  }

  function onPaste(e) {
    if (readOnly) {
      e.preventDefault();
      return;
    }
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    closeSlash();
    preSel = saveSel();
    const htmlStr = cd.getData('text/html') || '';
    const text = cd.getData('text/plain') || '';
    const files = imageFiles(cd.files?.length ? cd.files : [...(cd.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()));
    const b = curBlock();
    if (b?.tagName === 'PRE') {
      insertTextAtCaret(text.replace(/\r\n?/g, '\n'));
      afterMutation('cmd');
      return;
    }
    if (files.length && !htmlHasContent(htmlStr) && !text.trim()) {
      handleImageFiles(files);
      return;
    }
    if (files.length && /^\s*<img\b[^>]*>\s*$/i.test(htmlStr.replace(/<!--[\s\S]*?-->|<\/?(html|body|meta)[^>]*>/gi, ''))) {
      handleImageFiles(files);
      return;
    }
    const r = range();
    const url = text.trim();
    if (r && !r.collapsed && /^(https?:\/\/|mailto:)\S+$/i.test(url) && blockOf(r.startContainer) === blockOf(r.endContainer)) {
      exec('setLink', url);
      return;
    }
    if (insertClipboard(htmlStr, text)) {
      afterMutation('cmd');
      emit('rt:render');
    }
  }

  function selectionFragment() {
    const r = range();
    if (!r || r.collapsed) return null;
    const frag = r.cloneContents();
    const wrap = doc.createElement('div');
    const hasBlocks = [...frag.childNodes].some((n) => isEl(n) && (ROOT_BLOCKS.has(n.tagName) || LEAF_TAGS.has(n.tagName) || n.tagName === 'TR'));
    let node = frag;
    let anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
    while (anc && anc !== el && el.contains(anc)) {
      const t = anc.tagName;
      const structural = ['UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'TBODY', 'THEAD', 'TR'].includes(t);
      const inline = ['STRONG', 'EM', 'U', 'S', 'MARK', 'CODE', 'A'].includes(t) && !anc.closest('pre');
      if ((structural && hasBlocks) || (inline && !hasBlocks)) {
        const c = anc.cloneNode(false);
        c.appendChild(node);
        node = c;
      } else if (!hasBlocks && t === 'PRE') {
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.appendChild(node);
        pre.appendChild(code);
        node = pre;
      }
      anc = anc.parentNode;
    }
    wrap.appendChild(node);
    wrap.querySelectorAll('[data-uploading],[data-rt-marker]').forEach((n) => n.remove());
    return { wrap, text: sel().toString() };
  }

  function onCopy(e, cut = false) {
    const f = selectionFragment();
    if (!f || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', f.text);
    e.clipboardData.setData('text/html', f.wrap.innerHTML);
    if (cut && !readOnly) {
      preSel = saveSel();
      deleteSelection();
      afterMutation('cmd');
    }
  }

  function rangeFromPoint(x, y) {
    if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (!p) return null;
      const r = doc.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  function onDragOver(e) {
    if (readOnly) return;
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('Files')) e.preventDefault();
  }

  function onDrop(e) {
    if (readOnly) {
      e.preventDefault();
      return;
    }
    const dt = e.dataTransfer;
    if (!dt) return;
    let r = rangeFromPoint(e.clientX, e.clientY);
    if (r && !inEditor(r.startContainer)) r = null;
    // never drop into a figure / checkbox
    if (r) {
      const host = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
      const ui = host?.closest?.('[contenteditable="false"]');
      if (ui && ui !== el && el.contains(ui)) {
        r = doc.createRange();
        r.setStartAfter(topOf(ui) || ui);
        r.collapse(true);
      }
    }
    const files = imageFiles(dt.files);
    if (files.length) {
      e.preventDefault();
      preSel = saveSel();
      handleImageFiles(files, r);
      return;
    }
    const htmlStr = dt.getData('text/html');
    const text = dt.getData('text/plain');
    if (!htmlStr && !text) return;
    e.preventDefault();
    if (!r) return;
    preSel = saveSel();
    if (dragging) {
      const src = range();
      if (src && !src.collapsed) {
        if (src.comparePoint?.(r.startContainer, r.startOffset) === 0) return; // dropped onto itself
        const marker = doc.createElement('span');
        marker.setAttribute('data-rt-marker', '');
        r.insertNode(marker);
        deleteSelection();
        const after = doc.createRange();
        after.setStartBefore(marker);
        after.collapse(true);
        marker.remove();
        setRange(after);
      } else setRange(r);
    } else setRange(r);
    if (insertClipboard(htmlStr, text)) {
      afterMutation('cmd');
      emit('rt:render');
    }
  }

  /** Keeps the caret out of non-editable figures/checkboxes and off the root element. */
  function fixCaret() {
    const s = sel();
    if (!s || !s.rangeCount || !s.isCollapsed) return;
    const r = s.getRangeAt(0);
    const node = r.startContainer;
    if (!inEditor(node)) return;
    const elm = node.nodeType === 1 ? node : node.parentNode;
    const ui = elm.closest('[contenteditable="false"]');
    if (ui && ui !== el && el.contains(ui)) {
      const li = ui.parentElement;
      if (li?.tagName === 'LI') {
        caretAt(li, 0);
        return;
      }
      const top = topOf(ui) || ui;
      let next = top.nextElementSibling;
      if (!next || !firstLeafIn(next)) {
        next = newP();
        top.after(next);
      }
      caretAt(firstLeafIn(next), 0);
      return;
    }
    if (isEl(node, 'LI') && isUi(node.childNodes[r.startOffset])) {
      caretAt(node, 0);
      return;
    }
    if (node === el) {
      const child = el.childNodes[r.startOffset];
      const leafAfter = child && firstLeafIn(child);
      if (leafAfter && LEAF_TAGS.has(child.tagName)) return caretAt(leafAfter, 0);
      const prev = el.childNodes[r.startOffset - 1];
      const leafBefore = prev && lastLeafIn(prev);
      if (leafBefore && prev.tagName !== 'TABLE') return caretEnd(leafBefore);
      if (leafAfter) return caretAt(leafAfter, 0);
      const p = newP();
      el.insertBefore(p, child || null);
      caretAt(p, 0);
    }
  }

  function onSelectionChange() {
    if (destroyed) return;
    const r = range();
    if (!r) return;
    if (!composing && doc.activeElement === el) fixCaret();
    const s = saveSel();
    if (s) lastSaved = s;
    if (slash.isOpen() && slashQuery() == null) closeSlash();
    emitSelection();
  }

  function onBlur() {
    closeSlash();
    if (changeTimer) flush();
  }

  on(el, 'beforeinput', onBeforeInput);
  on(el, 'input', onInput);
  on(el, 'keydown', onKeyDown);
  on(el, 'compositionstart', onCompositionStart);
  on(el, 'compositionend', onCompositionEnd);
  on(el, 'mousedown', onMouseDown);
  on(el, 'click', onClick);
  on(el, 'paste', onPaste);
  on(el, 'copy', (e) => onCopy(e, false));
  on(el, 'cut', (e) => onCopy(e, true));
  on(el, 'dragstart', () => { dragging = true; });
  on(el, 'dragend', () => { dragging = false; });
  on(el, 'dragover', onDragOver);
  on(el, 'drop', onDrop);
  on(el, 'blur', onBlur);
  on(doc, 'selectionchange', onSelectionChange);

  /* ----- public API ----- */

  function setReadOnly(v) {
    readOnly = !!v;
    el.setAttribute('contenteditable', readOnly ? 'false' : 'true');
    el.setAttribute('aria-readonly', String(readOnly));
    if (readOnly) closeSlash();
  }

  function setMarkdown(md, { emit: emitChange = false, history = 'reset' } = {}) {
    if (destroyed) return;
    closeSlash();
    const prevMd = lastMd;
    if (history === 'push') {
      record('cmd');
      preSel = saveSel();
    }
    render(md);
    if (history === 'push') {
      record('cmd');
      scheduleChange();
    } else {
      clearTimeout(changeTimer);
      changeTimer = 0;
      lastMd = currentMd();
      resetHistory();
      if (emitChange) {
        lastMd = prevMd;
        scheduleChange();
      }
    }
    updateEmpty();
    emit('rt:render');
  }

  function focus(where = 'keep') {
    if (destroyed) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    if (where === 'start') {
      const l = firstLeafIn(el.firstElementChild);
      if (l) caretAt(l, 0);
    } else if (where === 'end' || !range()) {
      if (where !== 'end' && lastSaved && restoreSel(lastSaved)) return;
      const l = lastLeafIn(el.lastElementChild) || firstLeafIn(el.firstElementChild);
      if (l) caretEnd(l);
    }
  }

  function notifyChange() {
    if (destroyed) return;
    afterMutation('cmd');
  }

  function destroy() {
    if (destroyed) return;
    if (changeTimer) flush();
    destroyed = true;
    clearTimeout(changeTimer);
    clearTimeout(selRaf);
    listeners.splice(0).forEach((off) => off());
    slash.destroy();
    el.remove();
  }

  setReadOnly(readOnly);
  render(opts.markdown || '');
  lastMd = currentMd();
  resetHistory();
  updateEmpty();

  return {
    el,
    getMarkdown: currentMd,
    setMarkdown,
    focus,
    exec,
    state,
    insertMarkdown,
    undo,
    redo,
    canUndo: () => index > 0,
    canRedo: () => index < stack.length - 1,
    flush,
    notifyChange,
    setReadOnly,
    isReadOnly: () => readOnly,
    isEmpty: () => !currentMd().trim(),
    destroy,
  };
}
