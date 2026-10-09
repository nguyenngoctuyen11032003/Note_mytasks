// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  toggleMark, setBlock, toggleList, indent, outdent, setLink, insertHr, insertTable,
  transformCase, clearFormatting, activeState, findAll, replaceAll, replaceRange,
  getPendingMarks, clearPendingMarks, insertText, normalizeUrl, caseTransform,
  saveSelection, restoreSelection, textBlocks, CHECKBOX_CLASS,
} from '../../src/components/rich/commands.js';

/* ---------------------------------------------------------------------
   Helpers: '[' and ']' mark the selection, '|' a collapsed caret.
   --------------------------------------------------------------------- */

let root;

function setup(markup) {
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.setAttribute('contenteditable', 'true');
  document.body.appendChild(root);
  root.innerHTML = markup;
  let start = null; let end = null;
  const walker = [];
  (function walk(n) { for (const c of [...n.childNodes]) { if (c.nodeType === 3) walker.push(c); else walk(c); } })(root);
  for (const t of walker) {
    let i;
    while ((i = t.data.search(/[[\]|]/)) !== -1) {
      const ch = t.data[i];
      t.data = t.data.slice(0, i) + t.data.slice(i + 1);
      const p = { node: t, offset: i };
      if (ch === '|') { start = p; end = p; } else if (ch === '[') start = p; else end = p;
    }
  }
  // drop text nodes emptied by marker removal only if they are not selection anchors
  if (start) {
    const r = document.createRange();
    r.setStart(start.node, start.offset);
    r.setEnd(end.node, end.offset);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  return root;
}

/** innerHTML of root with the current selection drawn as [ ] (or | when collapsed). */
function show(el = root) {
  const sel = document.getSelection();
  const r = sel.rangeCount ? sel.getRangeAt(0) : null;
  const marks = [];
  if (r) {
    if (r.collapsed) marks.push([r.startContainer, r.startOffset, '|']);
    else { marks.push([r.startContainer, r.startOffset, '[']); marks.push([r.endContainer, r.endOffset, ']']); }
  }
  const at = (node, off) => marks.filter((m) => m[0] === node && m[1] === off).map((m) => m[2]).join('');
  function ser(n) {
    if (n.nodeType === 3) {
      let s = '';
      for (let i = 0; i <= n.data.length; i++) { s += at(n, i); if (i < n.data.length) s += esc(n.data[i]); }
      return s;
    }
    const tag = n.tagName.toLowerCase();
    const attrs = [...n.attributes].map((a) => ` ${a.name}="${a.value}"`).join('');
    let s = `<${tag}${attrs}>`;
    if (tag === 'br' || tag === 'hr') return s;
    for (let i = 0; i <= n.childNodes.length; i++) { s += at(n, i); if (i < n.childNodes.length) s += ser(n.childNodes[i]); }
    return s + `</${tag}>`;
  }
  let out = '';
  for (let i = 0; i <= el.childNodes.length; i++) { out += at(el, i); if (i < el.childNodes.length) out += ser(el.childNodes[i]); }
  return out;
}
const esc = (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c);
const plain = () => root.innerHTML;
const selText = () => document.getSelection().toString();
const CB = `<span class="${CHECKBOX_CLASS}" contenteditable="false" role="checkbox" aria-checked="false"></span>`;

beforeEach(() => { clearPendingMarks(root || document.body); });

/* =====================================================================
   toggleMark
   ===================================================================== */

describe('toggleMark', () => {
  const tags = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', mark: 'mark', code: 'code' };

  it.each(Object.entries(tags))('%s wraps a partial selection', (mark, tag) => {
    setup('<p>ab[cd]ef</p>');
    expect(toggleMark(root, mark)).toBe(true);
    expect(show()).toBe(`<p>ab<${tag}>[cd]</${tag}>ef</p>`);
  });

  it.each(Object.entries(tags))('%s applied twice restores the original DOM', (mark) => {
    setup('<p>ab[cd]ef</p>');
    toggleMark(root, mark);
    toggleMark(root, mark);
    expect(show()).toBe('<p>ab[cd]ef</p>');
  });

  it('fully marked selection is unwrapped', () => {
    setup('<p><strong>[abc]</strong></p>');
    toggleMark(root, 'bold');
    expect(show()).toBe('<p>[abc]</p>');
  });

  it('partially marked selection is fully marked and merged (no nesting)', () => {
    setup('<p>a[b<strong>c</strong>d]e</p>');
    toggleMark(root, 'bold');
    expect(show()).toBe('<p>a<strong>[bcd]</strong>e</p>');
    expect(root.querySelectorAll('strong strong').length).toBe(0);
  });

  it('extends an adjacent mark into one element', () => {
    setup('<p><strong>ab</strong>[cd]</p>');
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe('<p><strong>abcd</strong></p>');
    expect(selText()).toBe('cd');
  });

  it('unwraps the middle of a mark, splitting it', () => {
    setup('<p><strong>ab[cd]ef</strong></p>');
    toggleMark(root, 'bold');
    expect(show()).toBe('<p><strong>ab</strong>[cd]<strong>ef</strong></p>');
  });

  it('works across multiple blocks without wrapping blocks', () => {
    setup('<p>a[b</p><h2>cd</h2><p>e]f</p>');
    toggleMark(root, 'italic');
    expect(show()).toBe('<p>a<em>[b</em></p><h2><em>cd</em></h2><p><em>e]</em>f</p>');
    expect(root.querySelector('em > p, em > h2')).toBeNull();
  });

  it('multi-block toggle twice is idempotent', () => {
    const src = '<p>a[b</p><h2>cd</h2><p>e]f</p>';
    setup(src);
    toggleMark(root, 'italic'); toggleMark(root, 'italic');
    expect(show()).toBe(src);
  });

  it('keeps other marks while adding one', () => {
    setup('<p><em>a[bc]d</em></p>');
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe('<p><em>a<strong>bc</strong>d</em></p>');
    expect(selText()).toBe('bc');
  });

  it('removes a mark from inside nested marks', () => {
    setup('<p><strong><em>[ab]</em></strong></p>');
    toggleMark(root, 'italic');
    expect(show()).toBe('<p><strong>[ab]</strong></p>');
  });

  it('collapses duplicate nested marks already in the DOM', () => {
    setup('<p><strong><strong>a[b]</strong></strong>c</p>');
    toggleMark(root, 'italic');
    expect(root.querySelectorAll('strong').length).toBe(1);
    expect(root.innerHTML).toBe('<p><strong>a<em>b</em></strong>c</p>');
  });

  it('reads <b>/<i>/<del> aliases and writes canonical tags', () => {
    setup('<p><b>[ab</b><i>cd]</i></p>');
    toggleMark(root, 'strike');
    expect(root.innerHTML).toBe('<p><s><strong>ab</strong><em>cd</em></s></p>');
  });

  it('applying code strips other marks but keeps links', () => {
    setup('<p><a href="https://x.vn"><strong>[ab]</strong></a></p>');
    toggleMark(root, 'code');
    expect(root.innerHTML).toBe('<p><a href="https://x.vn"><code>ab</code></a></p>');
  });

  it('code is always innermost', () => {
    setup('<p><code>[ab]</code></p>');
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe('<p><strong><code>ab</code></strong></p>');
  });

  it('skips code blocks', () => {
    setup('<pre><code>[ab]</code></pre>');
    expect(toggleMark(root, 'bold')).toBe(false);
    expect(root.innerHTML).toBe('<pre><code>ab</code></pre>');
  });

  it('never marks a <br>', () => {
    setup('<p>[a<br>b]</p>');
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe('<p><strong>a</strong><br><strong>b</strong></p>');
  });

  it('works inside list items and keeps the checkbox out of marks', () => {
    setup(`<ul data-type="task"><li data-checked="false">${CB}[ab]</li></ul>`);
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe(`<ul data-type="task"><li data-checked="false">${CB}<strong>ab</strong></li></ul>`);
  });

  it('marks parent item text without touching nested list', () => {
    setup('<ul><li>[ab]<ul><li>cd</li></ul></li></ul>');
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe('<ul><li><strong>ab</strong><ul><li>cd</li></ul></li></ul>');
  });

  it('works inside table cells', () => {
    setup('<table><tbody><tr><td>[a]</td><td>b</td></tr></tbody></table>');
    toggleMark(root, 'underline');
    expect(root.querySelector('td').innerHTML).toBe('<u>a</u>');
  });

  it('selection spanning only a figure is a no-op', () => {
    setup('<p>a</p><figure class="rt-img" contenteditable="false"><img alt="x"></figure><p>b</p>');
    const r = document.createRange();
    r.selectNode(root.querySelector('figure'));
    document.getSelection().removeAllRanges(); document.getSelection().addRange(r);
    expect(toggleMark(root, 'bold')).toBe(false);
  });

  it('returns false with no selection inside the root', () => {
    setup('<p>ab</p>');
    document.getSelection().removeAllRanges();
    expect(toggleMark(root, 'bold')).toBe(false);
  });

  it('rejects unknown marks', () => {
    setup('<p>[ab]</p>');
    expect(toggleMark(root, 'blink')).toBe(false);
  });

  it('produces no empty marks', () => {
    setup('<p><strong>[ab</strong><strong>cd]</strong></p>');
    toggleMark(root, 'bold');
    for (const el of root.querySelectorAll('strong,em,u,s,mark,code')) expect(el.textContent).not.toBe('');
    expect(root.innerHTML).toBe('<p>abcd</p>');
  });

  it('handles Vietnamese text', () => {
    setup('<p>Chào [Việt Nam]!</p>');
    toggleMark(root, 'bold');
    expect(show()).toBe('<p>Chào <strong>[Việt Nam]</strong>!</p>');
  });

  it('selection from end of one block covers the next only', () => {
    setup('<p>ab[</p><p>cd]</p>');
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe('<p>ab</p><p><strong>cd</strong></p>');
  });
});

describe('pending marks (collapsed caret)', () => {
  it('collapsed toggle returns pending state and does not change the DOM', () => {
    setup('<p>ab|cd</p>');
    expect(toggleMark(root, 'bold')).toEqual({ pending: { bold: true } });
    expect(root.innerHTML).toBe('<p>abcd</p>');
    expect(getPendingMarks(root)).toEqual({ bold: true });
  });

  it('toggling twice clears the pending mark', () => {
    setup('<p>ab|cd</p>');
    toggleMark(root, 'bold'); toggleMark(root, 'bold');
    expect(getPendingMarks(root)).toEqual({});
  });

  it('pending off inside a mark', () => {
    setup('<p><strong>ab|</strong></p>');
    expect(toggleMark(root, 'bold')).toEqual({ pending: { bold: false } });
  });

  it('insertText applies pending marks and clears them', () => {
    setup('<p>ab|cd</p>');
    toggleMark(root, 'bold');
    insertText(root, 'X');
    expect(show()).toBe('<p>ab<strong>X|</strong>cd</p>');
    expect(getPendingMarks(root)).toEqual({});
  });

  it('insertText inherits the marks of the preceding text', () => {
    setup('<p><em>ab|</em>cd</p>');
    insertText(root, 'Z');
    expect(root.innerHTML).toBe('<p><em>abZ</em>cd</p>');
  });

  it('insertText with pending off leaves the mark', () => {
    setup('<p><strong>ab|</strong></p>');
    toggleMark(root, 'bold');
    insertText(root, 'c');
    expect(show()).toBe('<p><strong>ab</strong>c|</p>');
  });

  it('insertText at the end of a link does not extend it', () => {
    setup('<p><a href="https://a.vn">ab|</a></p>');
    insertText(root, 'c');
    expect(root.innerHTML).toBe('<p><a href="https://a.vn">ab</a>c</p>');
  });

  it('pending marks are dropped when the caret moves', () => {
    setup('<p>ab|cd</p>');
    toggleMark(root, 'italic');
    const t = root.querySelector('p').firstChild;
    const r = document.createRange(); r.setStart(t, 3); r.collapse(true);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(r);
    expect(getPendingMarks(root)).toEqual({});
  });

  it('insertText in an empty paragraph replaces the placeholder', () => {
    setup('<p><br></p>');
    const r = document.createRange(); r.setStart(root.firstChild, 0); r.collapse(true);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(r);
    toggleMark(root, 'mark');
    insertText(root, 'đ');
    expect(show()).toBe('<p><mark>đ|</mark></p>');
  });

  it('insertText replaces a selection within a block', () => {
    setup('<p>a[bc]d</p>');
    insertText(root, 'X');
    expect(show()).toBe('<p>aX|d</p>');
  });

  it('activeState reflects pending marks', () => {
    setup('<p>ab|</p>');
    toggleMark(root, 'underline');
    expect(activeState(root).underline).toBe(true);
  });
});

/* =====================================================================
   setBlock
   ===================================================================== */

describe('setBlock', () => {
  it.each(['h1', 'h2', 'h3'])('p -> %s and back', (h) => {
    setup('<p>a|b</p>');
    setBlock(root, h);
    expect(show()).toBe(`<${h}>a|b</${h}>`);
    setBlock(root, h);
    expect(show()).toBe('<p>a|b</p>');
  });

  it('keeps inline marks when changing heading level', () => {
    setup('<h1><strong>a|b</strong></h1>');
    setBlock(root, 'h2');
    expect(show()).toBe('<h2><strong>a|b</strong></h2>');
  });

  it('applies to every touched block', () => {
    setup('<p>a[b</p><p>c</p><p>d]e</p>');
    setBlock(root, 'h2');
    expect(show()).toBe('<h2>a[b</h2><h2>c</h2><h2>d]e</h2>');
  });

  it('mixed blocks are all set (not toggled)', () => {
    setup('<h2>a[b</h2><p>c]d</p>');
    setBlock(root, 'h2');
    expect(root.innerHTML).toBe('<h2>ab</h2><h2>cd</h2>');
  });

  it('ignores a trailing block selected at offset 0', () => {
    setup('<p>[ab</p><p>]cd</p>');
    setBlock(root, 'h1');
    expect(root.innerHTML).toBe('<h1>ab</h1><p>cd</p>');
  });

  it('setBlock p on paragraphs is a no-op', () => {
    setup('<p>a|b</p>');
    expect(setBlock(root, 'p')).toBe(false);
  });

  it('quote wraps into blockquote>p and toggles back', () => {
    setup('<p>a|b</p>');
    setBlock(root, 'quote');
    expect(show()).toBe('<blockquote><p>a|b</p></blockquote>');
    setBlock(root, 'quote');
    expect(show()).toBe('<p>a|b</p>');
  });

  it('quotes several paragraphs into one blockquote', () => {
    setup('<p>[a</p><p>b]</p>');
    setBlock(root, 'quote');
    expect(root.innerHTML).toBe('<blockquote><p>a</p><p>b</p></blockquote>');
  });

  it('merges with an adjacent blockquote', () => {
    setup('<blockquote><p>a</p></blockquote><p>b|</p>');
    setBlock(root, 'quote');
    expect(root.innerHTML).toBe('<blockquote><p>a</p><p>b</p></blockquote>');
  });

  it('unquoting a middle paragraph splits the blockquote', () => {
    setup('<blockquote><p>a</p><p>b|</p><p>c</p></blockquote>');
    setBlock(root, 'quote');
    expect(root.innerHTML).toBe('<blockquote><p>a</p></blockquote><p>b</p><blockquote><p>c</p></blockquote>');
  });

  it('heading on a quoted paragraph leaves the quote', () => {
    setup('<blockquote><p>a|</p></blockquote>');
    setBlock(root, 'h1');
    expect(root.innerHTML).toBe('<h1>a</h1>');
  });

  it('code merges paragraphs into one pre with newlines', () => {
    setup('<p>[a<strong>b</strong></p><p>c]</p>');
    setBlock(root, 'code');
    expect(root.innerHTML).toBe('<pre><code>ab\nc</code></pre>');
    expect(selText()).toBe('ab\nc');
  });

  it('code toggles back to paragraphs, one per line', () => {
    setup('<pre><code>a|b\ncd</code></pre>');
    setBlock(root, 'code');
    expect(show()).toBe('<p>a|b</p><p>cd</p>');
  });

  it('collapsed caret in a code block converts the whole block', () => {
    setup('<pre><code>x|y\nz</code></pre>');
    setBlock(root, 'code');
    expect(show()).toBe('<p>x|y</p><p>z</p>');
  });

  it('code -> p -> code round-trips', () => {
    setup('<pre><code>[xy\nz]</code></pre>');
    setBlock(root, 'code');
    expect(show()).toBe('<p>[xy</p><p>z]</p>');
    setBlock(root, 'code');
    expect(show()).toBe('<pre><code>[xy\nz]</code></pre>');
  });

  it('code -> h2 converts every line', () => {
    setup('<pre><code>a|\nb</code></pre>');
    setBlock(root, 'h2');
    expect(root.innerHTML).toBe('<h2>a</h2><h2>b</h2>');
  });

  it('empty code block line becomes an empty paragraph with placeholder', () => {
    setup('<pre><code>a|\n\nb</code></pre>');
    setBlock(root, 'p');
    expect(root.innerHTML).toBe('<p>a</p><p><br></p><p>b</p>');
  });

  it('heading on a list item takes it out of the list (splitting it)', () => {
    setup('<ul><li>a</li><li>b|</li><li>c</li></ul>');
    setBlock(root, 'h1');
    expect(show()).toBe('<ul><li>a</li></ul><h1>b|</h1><ul><li>c</li></ul>');
  });

  it('setBlock p on a list item makes it a paragraph', () => {
    setup('<ol><li>a|</li></ol>');
    setBlock(root, 'p');
    expect(show()).toBe('<p>a|</p>');
  });

  it('heading on a nested item lifts it to the top level', () => {
    setup('<ul><li>a<ul><li>b|</li></ul></li></ul>');
    setBlock(root, 'h2');
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><h2>b</h2>');
  });

  it('table cells are ignored', () => {
    setup('<table><tbody><tr><td>a|</td></tr></tbody></table>');
    expect(setBlock(root, 'h1')).toBe(false);
  });

  it('h4 is reported as h3', () => {
    setup('<h4>a|</h4>');
    expect(activeState(root).block).toBe('h3');
  });

  it('rejects unknown types', () => {
    setup('<p>a|</p>');
    expect(setBlock(root, 'h7')).toBe(false);
  });
});

/* =====================================================================
   Lists
   ===================================================================== */

describe('toggleList', () => {
  it.each([['ul', '<ul><li>a|b</li></ul>'], ['ol', '<ol><li>a|b</li></ol>'],
    ['task', `<ul data-type="task"><li data-checked="false">${CB}a|b</li></ul>`]])('p -> %s', (type, out) => {
    setup('<p>a|b</p>');
    toggleList(root, type);
    expect(show()).toBe(out);
  });

  it.each(['ul', 'ol', 'task'])('%s toggled twice returns the paragraph', (type) => {
    setup('<p>a|b</p>');
    toggleList(root, type); toggleList(root, type);
    expect(show()).toBe('<p>a|b</p>');
  });

  it('multiple paragraphs become one list', () => {
    setup('<p>[a</p><p>b</p><p>c]</p>');
    toggleList(root, 'ul');
    expect(show()).toBe('<ul><li>[a</li><li>b</li><li>c]</li></ul>');
  });

  it('multi-item toggle off returns paragraphs', () => {
    setup('<ul><li>[a</li><li>b]</li></ul>');
    toggleList(root, 'ul');
    expect(show()).toBe('<p>[a</p><p>b]</p>');
  });

  it('toggling off a middle item splits the list', () => {
    setup('<ol><li>a</li><li>b|</li><li>c</li></ol>');
    toggleList(root, 'ol');
    expect(root.innerHTML).toBe('<ol><li>a</li></ol><p>b</p><ol><li>c</li></ol>');
  });

  it('switches list type in place', () => {
    setup('<ul><li>a|</li><li>b</li></ul>');
    toggleList(root, 'ol');
    expect(show()).toBe('<ol><li>a|</li><li>b</li></ol>');
  });

  it('switches ul -> task adding checkboxes', () => {
    setup('<ul><li>a|</li><li>b</li></ul>');
    toggleList(root, 'task');
    expect(root.innerHTML).toBe(`<ul data-type="task"><li data-checked="false">${CB}a</li><li data-checked="false">${CB}b</li></ul>`);
  });

  it('switches task -> ol removing checkboxes', () => {
    setup(`<ul data-type="task"><li data-checked="true">${CB}a|</li></ul>`);
    toggleList(root, 'ol');
    expect(root.innerHTML).toBe('<ol><li>a</li></ol>');
  });

  it('keeps data-checked of existing task items', () => {
    setup('<ul data-type="task"><li data-checked="true"><span class="rt-check" contenteditable="false"></span>a|</li></ul>');
    expect(activeState(root).list).toBe('task');
    toggleList(root, 'task');
    expect(root.innerHTML).toBe('<p>a</p>');
  });

  it('appends a paragraph to the preceding list of the same type', () => {
    setup('<ul><li>a</li></ul><p>b|</p>');
    toggleList(root, 'ul');
    expect(show()).toBe('<ul><li>a</li><li>b|</li></ul>');
  });

  it('merges with the following list of the same type', () => {
    setup('<p>a|</p><ol><li>b</li></ol>');
    toggleList(root, 'ol');
    expect(root.innerHTML).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('does not merge with a list of another type', () => {
    setup('<ol><li>a</li></ol><p>b|</p>');
    toggleList(root, 'ul');
    expect(root.innerHTML).toBe('<ol><li>a</li></ol><ul><li>b</li></ul>');
  });

  it('mixed paragraph + list item converts both', () => {
    setup('<p>[a</p><ul><li>b]</li></ul>');
    toggleList(root, 'ol');
    expect(root.innerHTML).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('heading becomes a list item keeping inline marks', () => {
    setup('<h2><em>a|</em></h2>');
    toggleList(root, 'ul');
    expect(root.innerHTML).toBe('<ul><li><em>a</em></li></ul>');
  });

  it('quoted paragraph leaves the quote', () => {
    setup('<blockquote><p>a|</p></blockquote>');
    toggleList(root, 'ul');
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('code block lines become items', () => {
    setup('<pre><code>a|\nb</code></pre>');
    toggleList(root, 'ol');
    expect(root.innerHTML).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('empty paragraph becomes an empty item with placeholder', () => {
    setup('<p><br></p>');
    const r = document.createRange(); r.setStart(root.firstChild, 0); r.collapse(true);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(r);
    toggleList(root, 'task');
    expect(root.innerHTML).toBe(`<ul data-type="task"><li data-checked="false">${CB}<br></li></ul>`);
  });

  it('toggle off a nested item lifts it to a paragraph', () => {
    setup('<ul><li>a<ul><li>b|</li></ul></li></ul>');
    toggleList(root, 'ul');
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><p>b</p>');
  });

  it('lifting an item with children keeps the children as a list', () => {
    setup('<ul><li>a|<ul><li>b</li></ul></li></ul>');
    toggleList(root, 'ul');
    expect(root.innerHTML).toBe('<p>a</p><ul><li>b</li></ul>');
  });

  it('rejects unknown types', () => {
    setup('<p>a|</p>');
    expect(toggleList(root, 'dl')).toBe(false);
  });
});

describe('indent / outdent', () => {
  it('indent nests under the previous item', () => {
    setup('<ul><li>a</li><li>b|</li></ul>');
    expect(indent(root)).toBe(true);
    expect(show()).toBe('<ul><li>a<ul><li>b|</li></ul></li></ul>');
  });

  it('indent first item is a no-op', () => {
    setup('<ul><li>a|</li><li>b</li></ul>');
    expect(indent(root)).toBe(false);
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('indent outside a list returns false', () => {
    setup('<p>a|</p>');
    expect(indent(root)).toBe(false);
  });

  it('indent appends to an existing sublist', () => {
    setup('<ul><li>a<ul><li>x</li></ul></li><li>b|</li></ul>');
    indent(root);
    expect(root.innerHTML).toBe('<ul><li>a<ul><li>x</li><li>b</li></ul></li></ul>');
  });

  it('indent several items keeps their order', () => {
    setup('<ol><li>a</li><li>[b</li><li>c]</li></ol>');
    indent(root);
    expect(show()).toBe('<ol><li>a<ol><li>[b</li><li>c]</li></ol></li></ol>');
  });

  it('indent moves children along', () => {
    setup('<ul><li>a</li><li>b|<ul><li>c</li></ul></li></ul>');
    indent(root);
    expect(root.innerHTML).toBe('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>');
  });

  it('indent in a task list keeps task semantics', () => {
    setup(`<ul data-type="task"><li data-checked="false">${CB}a</li><li data-checked="true">${CB}b|</li></ul>`);
    indent(root);
    expect(root.innerHTML).toBe(`<ul data-type="task"><li data-checked="false">${CB}a<ul data-type="task"><li data-checked="true">${CB}b</li></ul></li></ul>`);
  });

  it('outdent moves a nested item up', () => {
    setup('<ul><li>a<ul><li>b|</li></ul></li></ul>');
    outdent(root);
    expect(show()).toBe('<ul><li>a</li><li>b|</li></ul>');
  });

  it('indent then outdent restores the DOM', () => {
    const src = '<ul><li>a</li><li>b|</li><li>c</li></ul>';
    setup(src);
    indent(root); outdent(root);
    expect(show()).toBe(src);
  });

  it('outdent: following siblings become children', () => {
    setup('<ul><li>a<ul><li>b|</li><li>c</li></ul></li></ul>');
    outdent(root);
    expect(root.innerHTML).toBe('<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>');
  });

  it('outdent several nested items', () => {
    setup('<ul><li>a<ul><li>[b</li><li>c]</li></ul></li></ul>');
    outdent(root);
    expect(show()).toBe('<ul><li>a</li><li>[b</li><li>c]</li></ul>');
  });

  it('outdent a top-level item makes a paragraph', () => {
    setup('<ul><li>a|</li></ul>');
    outdent(root);
    expect(show()).toBe('<p>a|</p>');
  });

  it('outdent from a ul sublist into a task list adds a checkbox', () => {
    setup(`<ul data-type="task"><li data-checked="false">${CB}a<ul><li>b|</li></ul></li></ul>`);
    outdent(root);
    expect(root.innerHTML).toBe(`<ul data-type="task"><li data-checked="false">${CB}a</li><li data-checked="false">${CB}b</li></ul>`);
  });

  it('outdent outside a list returns false', () => {
    setup('<p>a|</p>');
    expect(outdent(root)).toBe(false);
  });
});

/* =====================================================================
   Links
   ===================================================================== */

describe('normalizeUrl', () => {
  it.each([
    ['https://a.vn/x', 'https://a.vn/x'],
    ['http://a.vn', 'http://a.vn'],
    ['mailto:a@b.vn', 'mailto:a@b.vn'],
    ['example.com', 'https://example.com'],
    ['www.báo.vn/tin?a=1', 'https://www.báo.vn/tin?a=1'],
    ['a@b.vn', 'mailto:a@b.vn'],
    ['  https://x.vn  ', 'https://x.vn'],
    ['javascript:alert(1)', null],
    ['data:text/html,x', null],
    ['ftp://x.vn', null],
    ['not a url', null],
    ['', null],
  ])('%s -> %s', (input, out) => {
    expect(normalizeUrl(input)).toBe(out);
  });
});

describe('setLink', () => {
  it('links the selection', () => {
    setup('<p>a[bc]d</p>');
    expect(setLink(root, 'https://x.vn')).toBe(true);
    expect(show()).toBe('<p>a<a href="https://x.vn">[bc]</a>d</p>');
  });

  it('adds https:// to bare domains', () => {
    setup('<p>[ab]</p>');
    setLink(root, 'google.com');
    expect(root.innerHTML).toBe('<p><a href="https://google.com">ab</a></p>');
  });

  it('rejects unsafe urls', () => {
    setup('<p>[ab]</p>');
    expect(setLink(root, 'javascript:alert(1)')).toBe(false);
    expect(root.innerHTML).toBe('<p>ab</p>');
  });

  it('caret inside a link edits the whole link', () => {
    setup('<p><a href="https://a.vn">a|b</a>c</p>');
    setLink(root, 'https://b.vn');
    expect(show()).toBe('<p><a href="https://b.vn">a|b</a>c</p>');
  });

  it('selection inside a link edits the whole link', () => {
    setup('<p><a href="https://a.vn">a[b]c</a></p>');
    setLink(root, 'https://b.vn');
    expect(root.innerHTML).toBe('<p><a href="https://b.vn">abc</a></p>');
  });

  it('caret inside a link + null unlinks keeping text', () => {
    setup('<p>x<a href="https://a.vn"><strong>a|b</strong></a></p>');
    setLink(root, null);
    expect(show()).toBe('<p>x<strong>a|b</strong></p>');
  });

  it('unlink a partial selection splits the link', () => {
    setup('<p><a href="https://a.vn">a[b]c</a></p>');
    setLink(root, null);
    expect(root.innerHTML).toBe('<p><a href="https://a.vn">a</a>b<a href="https://a.vn">c</a></p>');
  });

  it('collapsed caret outside a link inserts the url as a link', () => {
    setup('<p>ab|</p>');
    setLink(root, 'x.vn');
    expect(show()).toBe('<p>ab<a href="https://x.vn">x.vn</a>|</p>');
  });

  it('link over marks keeps them', () => {
    setup('<p>[a<em>b</em>]</p>');
    setLink(root, 'https://x.vn');
    expect(root.innerHTML).toBe('<p><a href="https://x.vn">a<em>b</em></a></p>');
  });

  it('link across blocks makes one link per block', () => {
    setup('<p>a[b</p><p>c]d</p>');
    setLink(root, 'https://x.vn');
    expect(root.querySelectorAll('a').length).toBe(2);
  });

  it('unlink with collapsed caret outside a link is a no-op', () => {
    setup('<p>a|b</p>');
    expect(setLink(root, null)).toBe(false);
  });

  it('activeState reports link and href', () => {
    setup('<p><a href="https://a.vn">a|b</a></p>');
    const st = activeState(root);
    expect(st.link).toBe(true);
    expect(st.href).toBe('https://a.vn');
  });
});

/* =====================================================================
   Insert hr / table
   ===================================================================== */

describe('insertHr', () => {
  it('inserts after a paragraph with the caret at end, adding a paragraph', () => {
    setup('<p>ab|</p>');
    insertHr(root);
    expect(show()).toBe('<p>ab</p><hr><p>|<br></p>');
  });

  it('replaces an empty paragraph', () => {
    setup('<p>a</p><p><br></p><p>b</p>');
    const r = document.createRange(); r.setStart(root.children[1], 0); r.collapse(true);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(r);
    insertHr(root);
    expect(show()).toBe('<p>a</p><hr><p>|b</p>');
  });

  it('splits a paragraph at the caret', () => {
    setup('<p><strong>a|b</strong></p>');
    insertHr(root);
    expect(show()).toBe('<p><strong>a</strong></p><hr><p><strong>|b</strong></p>');
  });

  it('at paragraph start inserts before it', () => {
    setup('<p>|ab</p>');
    insertHr(root);
    expect(show()).toBe('<hr><p>|ab</p>');
  });

  it('inside a list inserts after the whole list', () => {
    setup('<ul><li>a|</li></ul><p>z</p>');
    insertHr(root);
    expect(root.innerHTML).toBe('<ul><li>a</li></ul><hr><p>z</p>');
  });
});

describe('insertTable', () => {
  it('builds header + body rows with caret in the first cell', () => {
    setup('<p>a|</p>');
    insertTable(root, 3, 2);
    const t = root.querySelector('table');
    expect(t.querySelectorAll('thead th').length).toBe(2);
    expect(t.querySelectorAll('tbody tr').length).toBe(2);
    expect(t.nextElementSibling.tagName).toBe('P');
    const r = document.getSelection().getRangeAt(0);
    expect(r.startContainer).toBe(t.querySelector('th'));
  });

  it('defaults to 3x3', () => {
    setup('<p><br></p>');
    const r = document.createRange(); r.setStart(root.firstChild, 0); r.collapse(true);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(r);
    insertTable(root);
    expect(root.querySelectorAll('th').length).toBe(3);
    expect(root.querySelectorAll('td').length).toBe(6);
    expect(root.firstElementChild.tagName).toBe('TABLE');
  });

  it('clamps silly sizes', () => {
    setup('<p>a|</p>');
    insertTable(root, 0, 999);
    expect(root.querySelectorAll('th').length).toBe(20);
  });

  it('works with no selection (appends)', () => {
    setup('<p>a</p>');
    document.getSelection().removeAllRanges();
    insertTable(root, 2, 2);
    expect(root.lastElementChild.tagName).toBe('P');
    expect(root.querySelector('table')).not.toBeNull();
  });
});

/* =====================================================================
   transformCase
   ===================================================================== */

describe('caseTransform (string)', () => {
  const all = (s, m) => caseTransform(s, 0, s.length, m);
  it.each([
    ['nguyễn văn đức', 'title', 'Nguyễn Văn Đức'],
    ['NGUYỄN VĂN ĐỨC', 'title', 'Nguyễn Văn Đức'],
    ['đường', 'upper', 'ĐƯỜNG'],
    ['ĐƯỜNG PHỐ', 'lower', 'đường phố'],
    ['ấp ủ ước mơ', 'upper', 'ẤP Ủ ƯỚC MƠ'],
    ['hôm nay trời đẹp. đi chơi thôi! được không? ừ', 'sentence', 'Hôm nay trời đẹp. Đi chơi thôi! Được không? Ừ'],
    ['XIN CHÀO. TẠM BIỆT', 'sentence', 'Xin chào. Tạm biệt'],
    ['www.example.com là web', 'sentence', 'Www.example.com là web'],
    ["it's đẹp", 'title', "It's Đẹp"],
    ['3 quả táo', 'sentence', '3 quả táo'],
    ['"xin chào." "tạm biệt"', 'sentence', '"Xin chào." "Tạm biệt"'],
    ['dòng một\ndòng hai', 'sentence', 'Dòng một\nDòng hai'],
    ['é à', 'upper', 'É À'],
  ])('%s (%s) -> %s', (input, mode, out) => {
    expect(all(input, mode)).toBe(out);
  });

  it('respects context before the range for title case', () => {
    expect(caseTransform('abc def', 1, 7, 'title')).toBe('abc Def');
  });

  it('keeps length for every mode', () => {
    const s = 'Straße đường İstanbul';
    for (const m of ['upper', 'lower', 'title', 'sentence']) expect(caseTransform(s, 0, s.length, m).length).toBe(s.length);
  });
});

describe('transformCase (DOM)', () => {
  it('uppercases the selection only', () => {
    setup('<p>ab[cd]ef</p>');
    transformCase(root, 'upper');
    expect(show()).toBe('<p>ab[CD]ef</p>');
  });

  it('title case across marks and links keeps them', () => {
    setup('<p>[nguyễn <strong>văn</strong> <a href="https://a.vn">đức</a>]</p>');
    transformCase(root, 'title');
    expect(root.innerHTML).toBe('<p>Nguyễn <strong>Văn</strong> <a href="https://a.vn">Đức</a></p>');
    expect(selText()).toBe('Nguyễn Văn Đức');
  });

  it('word split by a mark is treated as one word', () => {
    setup('<p>[ng<em>uyễn</em>]</p>');
    transformCase(root, 'title');
    expect(root.innerHTML).toBe('<p>Ng<em>uyễn</em></p>');
  });

  it('collapsed caret transforms the current word', () => {
    setup('<p>xin ch|ào bạn</p>');
    transformCase(root, 'upper');
    expect(show()).toBe('<p>xin CH|ÀO bạn</p>');
  });

  it('collapsed caret on whitespace is a no-op', () => {
    setup('<p>a | b</p>');
    expect(transformCase(root, 'upper')).toBe(false);
  });

  it('sentence case across blocks starts each block with a capital', () => {
    setup('<p>[HELLO. WORLD</p><p>BYE]</p>');
    transformCase(root, 'sentence');
    expect(root.innerHTML).toBe('<p>Hello. World</p><p>Bye</p>');
  });

  it('upper then lower restores lowercase text', () => {
    setup('<p>[đường phố]</p>');
    transformCase(root, 'upper');
    expect(root.textContent).toBe('ĐƯỜNG PHỐ');
    transformCase(root, 'lower');
    expect(show()).toBe('<p>[đường phố]</p>');
  });

  it('works in code blocks', () => {
    setup('<pre><code>[abc]</code></pre>');
    transformCase(root, 'upper');
    expect(root.innerHTML).toBe('<pre><code>ABC</code></pre>');
  });

  it('unknown mode returns false', () => {
    setup('<p>[a]</p>');
    expect(transformCase(root, 'snake')).toBe(false);
  });

  it('returns false when nothing changes', () => {
    setup('<p>[ABC]</p>');
    expect(transformCase(root, 'upper')).toBe(false);
  });
});

/* =====================================================================
   clearFormatting / activeState
   ===================================================================== */

describe('clearFormatting', () => {
  it('removes all marks but keeps links', () => {
    setup('<h2>[<strong>a</strong><a href="https://x.vn"><em>b</em></a><mark>c</mark>]</h2>');
    clearFormatting(root);
    expect(show()).toBe('<p>[a<a href="https://x.vn">b</a>c]</p>');
  });

  it('turns quotes and code into paragraphs', () => {
    setup('<blockquote><p>a|</p></blockquote>');
    clearFormatting(root);
    expect(root.innerHTML).toBe('<p>a</p>');
  });

  it('keeps lists', () => {
    setup('<ul><li><strong>[a]</strong></li></ul>');
    clearFormatting(root);
    expect(root.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('collapsed caret in bold sets pending off', () => {
    setup('<p><strong>ab|</strong></p>');
    expect(clearFormatting(root)).toBe(true);
    expect(getPendingMarks(root)).toEqual({ bold: false });
  });

  it('partial selection only clears that part', () => {
    setup('<p><strong>a[b]c</strong></p>');
    clearFormatting(root);
    expect(show()).toBe('<p><strong>a</strong>[b]<strong>c</strong></p>');
  });

  it('no formatting -> false', () => {
    setup('<p>[ab]</p>');
    expect(clearFormatting(root)).toBe(false);
  });
});

describe('activeState', () => {
  it('defaults for plain paragraph', () => {
    setup('<p>a|b</p>');
    expect(activeState(root)).toMatchObject({ bold: false, italic: false, link: false, block: 'p', list: null });
  });

  it('caret inside bold+italic', () => {
    setup('<p><strong><em>a|b</em></strong></p>');
    expect(activeState(root)).toMatchObject({ bold: true, italic: true, underline: false });
  });

  it('caret right after bold text reports bold', () => {
    setup('<p><strong>ab</strong>|cd</p>');
    expect(activeState(root).bold).toBe(true);
  });

  it('caret at block start reports the following text', () => {
    setup('<p><em>|ab</em></p>');
    expect(activeState(root).italic).toBe(true);
  });

  it('selection is bold only if wholly bold', () => {
    setup('<p>[a<strong>b</strong>]</p>');
    expect(activeState(root).bold).toBe(false);
    setup('<p><strong>[a</strong><strong><em>b]</em></strong></p>');
    expect(activeState(root).bold).toBe(true);
    expect(activeState(root).italic).toBe(false);
  });

  it.each([
    ['<h1>a|</h1>', 'h1'], ['<h2>a|</h2>', 'h2'], ['<h3>a|</h3>', 'h3'],
    ['<blockquote><p>a|</p></blockquote>', 'quote'], ['<pre><code>a|</code></pre>', 'code'],
  ])('block of %s is %s', (src, block) => {
    setup(src);
    expect(activeState(root).block).toBe(block);
  });

  it.each([
    ['<ul><li>a|</li></ul>', 'ul'], ['<ol><li>a|</li></ol>', 'ol'],
    [`<ul data-type="task"><li data-checked="false">${CB}a|</li></ul>`, 'task'],
    ['<ol><li>x<ul><li>a|</li></ul></li></ol>', 'ul'],
  ])('list of %s is %s', (src, list) => {
    setup(src);
    expect(activeState(root).list).toBe(list);
  });

  it('code block does not report inline code', () => {
    setup('<pre><code>a|b</code></pre>');
    expect(activeState(root).code).toBe(false);
  });

  it('table cell reports table', () => {
    setup('<table><tbody><tr><td>a|</td></tr></tbody></table>');
    expect(activeState(root).table).toBe(true);
  });

  it('no selection returns defaults', () => {
    setup('<p><strong>a</strong></p>');
    document.getSelection().removeAllRanges();
    expect(activeState(root).bold).toBe(false);
  });
});

/* =====================================================================
   Find / replace
   ===================================================================== */

describe('findAll / replaceAll', () => {
  it('finds case-insensitively by default (Vietnamese)', () => {
    setup('<p>Đường xa. đường gần. ĐƯỜNG</p>');
    const rs = findAll(root, 'đường');
    expect(rs.length).toBe(3);
    expect(rs.map((r) => r.toString())).toEqual(['Đường', 'đường', 'ĐƯỜNG']);
  });

  it('case-sensitive option', () => {
    setup('<p>Đường đường</p>');
    expect(findAll(root, 'đường', { caseSensitive: true }).length).toBe(1);
  });

  it('diacritics matter (ma ≠ mà)', () => {
    setup('<p>ma mà má</p>');
    expect(findAll(root, 'ma').length).toBe(1);
  });

  it('matches across text-node boundaries within a block', () => {
    setup('<p>ng<strong>uyễ</strong>n</p>');
    const rs = findAll(root, 'nguyễn');
    expect(rs.length).toBe(1);
    expect(rs[0].toString()).toBe('nguyễn');
  });

  it('does not match across blocks', () => {
    setup('<p>ab</p><p>cd</p>');
    expect(findAll(root, 'bc').length).toBe(0);
  });

  it('whole word option', () => {
    setup('<p>an bàn an</p>');
    expect(findAll(root, 'an', { wholeWord: true }).length).toBe(2);
  });

  it('empty query finds nothing', () => {
    setup('<p>ab</p>');
    expect(findAll(root, '')).toEqual([]);
    expect(replaceAll(root, '', 'x')).toBe(0);
  });

  it('finds in list items, cells and code blocks', () => {
    setup('<ul><li>xa</li></ul><table><tbody><tr><td>xa</td></tr></tbody></table><pre><code>xa</code></pre>');
    expect(findAll(root, 'x').length).toBe(3);
  });

  it('replaceAll returns the count and keeps marks of the first char', () => {
    setup('<p>ng<strong>uyễ</strong>n và Nguyễn</p>');
    expect(replaceAll(root, 'nguyễn', 'Trần')).toBe(2);
    expect(root.innerHTML).toBe('<p>Trần và Trần</p>');
  });

  it('replaceAll inside a mark keeps the mark', () => {
    setup('<p><strong>chào bạn</strong></p>');
    replaceAll(root, 'bạn', 'em');
    expect(root.innerHTML).toBe('<p><strong>chào em</strong></p>');
  });

  it('replaceAll with empty replacement deletes and leaves no empty marks', () => {
    setup('<p>a<em>xx</em>b</p>');
    replaceAll(root, 'xx', '');
    expect(root.innerHTML).toBe('<p>ab</p>');
  });

  it('replacing the whole block text leaves a placeholder', () => {
    setup('<p>xx</p>');
    replaceAll(root, 'xx', '');
    expect(root.innerHTML).toBe('<p><br></p>');
  });

  it('replaceAll in a code block', () => {
    setup('<pre><code>let a = a;</code></pre>');
    expect(replaceAll(root, 'a', 'b', { caseSensitive: true, wholeWord: true })).toBe(2);
    expect(root.textContent).toBe('let b = b;');
  });

  it('replaceRange replaces one match and selects it', () => {
    setup('<p>một hai một</p>');
    const [, second] = findAll(root, 'một');
    expect(replaceRange(root, second, 'ba')).toBe(true);
    expect(show()).toBe('<p>một hai [ba]</p>');
  });

  it('replaceAll when nothing matches returns 0', () => {
    setup('<p>ab</p>');
    expect(replaceAll(root, 'zz', 'y')).toBe(0);
    expect(root.innerHTML).toBe('<p>ab</p>');
  });
});

/* =====================================================================
   Selection model
   ===================================================================== */

describe('saveSelection / restoreSelection', () => {
  it('round-trips a multi-block selection', () => {
    setup('<p>a[b</p><ul><li>c</li></ul><p>d]e</p>');
    const s = saveSelection(root);
    expect(s).toEqual({ start: 1, end: 6 });
    document.getSelection().removeAllRanges();
    restoreSelection(root, s);
    expect(show()).toBe('<p>a[b</p><ul><li>c</li></ul><p>d]e</p>');
  });

  it('ignores the checkbox and trailing placeholder br', () => {
    setup(`<ul data-type="task"><li data-checked="false">${CB}a|b</li></ul><p><br></p>`);
    expect(saveSelection(root)).toEqual({ start: 1, end: 1 });
  });

  it('clamps out-of-range offsets', () => {
    setup('<p>ab</p>');
    restoreSelection(root, { start: 99, end: 99 });
    expect(show()).toBe('<p>ab|</p>');
  });

  it('null when the selection is outside the root', () => {
    setup('<p>ab</p>');
    document.getSelection().removeAllRanges();
    expect(saveSelection(root)).toBeNull();
  });

  it('selection at the root level maps to the nearest block', () => {
    setup('<p>ab</p><hr><p>cd</p>');
    const r = document.createRange(); r.setStart(root, 1); r.setEnd(root, 3);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(r);
    expect(saveSelection(root)).toEqual({ start: 3, end: 5 });
  });

  it('textBlocks lists blocks in document order, skipping figures', () => {
    setup('<p>a</p><figure class="rt-img" contenteditable="false"><img></figure><ul><li>b<ol><li>c</li></ol></li></ul><blockquote><p>d</p></blockquote>');
    expect(textBlocks(root).map((b) => b.textContent)).toEqual(['a', 'bc', 'c', 'd']);
  });

  it('stray text at the root is wrapped into a paragraph', () => {
    setup('ab|');
    toggleMark(root, 'bold');
    expect(root.innerHTML).toBe('<p>ab</p>');
  });
});
