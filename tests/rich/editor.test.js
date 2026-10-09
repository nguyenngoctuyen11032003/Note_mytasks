// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRichEditor, sanitizeHtml, looksLikeMarkdown, keepSpaces, offsetIn, pointAt, textOf } from '../../src/components/rich/editor.js';
import { SLASH_ITEMS, filterSlashItems, foldVi } from '../../src/components/rich/slashMenu.js';
import { htmlToMd } from '../../src/components/rich/markdown.js';

/* ---------------------------------------------------------------------
   Helpers — happy-dom has no editing engine, so "native" typing is simulated:
   beforeinput (cancelable) → default action → input, like a browser does.
   --------------------------------------------------------------------- */

let ed;
let host;
const changes = [];

function make(markdown = '', extra = {}) {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  changes.length = 0;
  ed = createRichEditor(host, { markdown, onChange: (md) => changes.push(md), ...extra });
  ed.el.focus();
  return ed;
}

function caretIn(text, at = text.length, root = ed.el) {
  const walker = document.createTreeWalker(root, 4);
  let n;
  while ((n = walker.nextNode())) {
    const i = n.data.indexOf(text);
    if (i >= 0) {
      setCaret(n, i + at);
      return n;
    }
  }
  throw new Error(`text not found: ${text}`);
}

function setCaret(node, off) {
  const r = document.createRange();
  r.setStart(node, off);
  r.collapse(true);
  const s = document.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function caretEndOf(block) {
  const [n, o] = pointAt(block, textOf(block).length);
  setCaret(n, o);
}

function selectText(text, root = ed.el) {
  const walker = document.createTreeWalker(root, 4);
  let n;
  while ((n = walker.nextNode())) {
    const i = n.data.indexOf(text);
    if (i >= 0) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + text.length);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
  }
  throw new Error(`text not found: ${text}`);
}

const fire = (type, init) => {
  const ev = new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', ...init });
  ed.el.dispatchEvent(ev);
  return ev;
};

/** Native-like insertion of one chunk at the caret. */
function nativeInsert(data) {
  const s = document.getSelection();
  const r = s.getRangeAt(0);
  if (!r.collapsed) r.deleteContents();
  let node = r.startContainer;
  let off = r.startOffset;
  if (node.nodeType !== 3) {
    // browsers type into the adjacent text node when there is one
    const prev = node.childNodes[off - 1];
    if (prev && prev.nodeType === 3) {
      node = prev;
      off = prev.data.length;
    } else {
      const t = document.createTextNode('');
      const ref = node.childNodes[off] || null;
      if (ref && ref.nodeName === 'BR' && !ref.nextSibling) ref.remove();
      node.insertBefore(t, node.childNodes[off] || null);
      node = t;
      off = 0;
    }
  }
  node.insertData(off, data);
  setCaret(node, off + data.length);
}

function type(str) {
  for (const ch of [...str]) {
    const ev = fire('beforeinput', { inputType: 'insertText', data: ch });
    if (ev.defaultPrevented) continue;
    nativeInsert(ch);
    fire('input', { inputType: 'insertText', data: ch });
  }
}

function enter(shift = false) {
  const ev = fire('beforeinput', { inputType: shift ? 'insertLineBreak' : 'insertParagraph' });
  expect(ev.defaultPrevented).toBe(true);
}

function backspace() {
  const ev = fire('beforeinput', { inputType: 'deleteContentBackward' });
  if (ev.defaultPrevented) return;
  const s = document.getSelection();
  const r = s.getRangeAt(0);
  if (r.collapsed && r.startContainer.nodeType === 3 && r.startOffset > 0) {
    const node = r.startContainer;
    const off = r.startOffset;
    node.deleteData(off - 1, 1);
    setCaret(node, off - 1);
  } else if (!r.collapsed) r.deleteContents();
  fire('input', { inputType: 'deleteContentBackward' });
}

function key(k, opts = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  ed.el.dispatchEvent(ev);
  return ev;
}

function paste({ html = '', text = '', files = [] } = {}) {
  const data = { 'text/html': html, 'text/plain': text };
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { getData: (t) => data[t] || '', files, items: [] };
  ed.el.dispatchEvent(ev);
  return ev;
}

const md = () => ed.getMarkdown();

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  ed?.destroy();
  ed = null;
});

/* --------------------------------------------------------------------- */

describe('createRichEditor — basics', () => {
  it('builds an accessible contenteditable root from Markdown', () => {
    make('# Tiêu đề\n\nĐoạn **đậm**', { placeholder: 'Viết gì đó…' });
    const el = ed.el;
    expect(el.className).toContain('rt');
    expect(el.getAttribute('contenteditable')).toBe('true');
    expect(el.getAttribute('role')).toBe('textbox');
    expect(el.getAttribute('aria-multiline')).toBe('true');
    expect(el.getAttribute('aria-label')).toBeTruthy();
    expect(el.getAttribute('data-placeholder')).toBe('Viết gì đó…');
    expect(el.querySelector('h1').textContent).toBe('Tiêu đề');
    expect(el.querySelector('strong').textContent).toBe('đậm');
    expect(md()).toBe('# Tiêu đề\n\nĐoạn **đậm**');
    expect(host.contains(el)).toBe(true);
  });

  it('always keeps at least one paragraph and flags the empty state', () => {
    make('');
    expect(ed.el.children.length).toBe(1);
    expect(ed.el.firstElementChild.tagName).toBe('P');
    expect(ed.el.classList.contains('is-empty')).toBe(true);
    expect(ed.isEmpty()).toBe(true);
    caretEndOf(ed.el.firstElementChild);
    type('a');
    expect(ed.el.classList.contains('is-empty')).toBe(false);
  });

  it('adds a paragraph after a trailing image so the caret has a place', () => {
    make('Ảnh:\n\n![mèo](nm-media:u/n/a.webp)');
    expect(ed.el.lastElementChild.tagName).toBe('P');
    expect(md()).toBe('Ảnh:\n\n![mèo](nm-media:u/n/a.webp)');
  });

  it('readOnly turns editing off and blocks input', () => {
    make('abc', { readOnly: true });
    expect(ed.el.getAttribute('contenteditable')).toBe('false');
    expect(ed.el.getAttribute('aria-readonly')).toBe('true');
    const ev = fire('beforeinput', { inputType: 'insertText', data: 'x' });
    expect(ev.defaultPrevented).toBe(true);
    ed.setReadOnly(false);
    expect(ed.el.getAttribute('contenteditable')).toBe('true');
  });

  it('onChange is debounced 300 ms and only fires when the Markdown changed', () => {
    vi.useFakeTimers();
    make('Xin chào');
    caretIn('Xin chào');
    type(' bạn');
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(299);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual(['Xin chào bạn']);
    // a selection-only "change" emits nothing
    ed.notifyChange();
    vi.advanceTimersByTime(400);
    expect(changes.length).toBe(1);
  });

  it('setMarkdown replaces content silently and resets history', () => {
    vi.useFakeTimers();
    make('một');
    caretIn('một');
    type('!');
    ed.setMarkdown('## hai');
    vi.advanceTimersByTime(400);
    expect(changes).toEqual([]);
    expect(md()).toBe('## hai');
    expect(ed.canUndo()).toBe(false);
    ed.setMarkdown('ba', { emit: true });
    vi.advanceTimersByTime(400);
    expect(changes).toEqual(['ba']);
  });

  it('setMarkdown with history:"push" is undoable', () => {
    make('cũ');
    ed.setMarkdown('mới', { history: 'push' });
    expect(ed.canUndo()).toBe(true);
    ed.undo();
    expect(md()).toBe('cũ');
    ed.redo();
    expect(md()).toBe('mới');
  });

  it('destroy flushes a pending change and removes the element and listeners', () => {
    vi.useFakeTimers();
    make('a');
    caretIn('a');
    type('b');
    const el = ed.el;
    ed.destroy();
    expect(changes).toEqual(['ab']);
    expect(el.isConnected).toBe(false);
    ed = null;
    // events on the detached element no longer do anything
    const ev = new InputEvent('beforeinput', { inputType: 'insertParagraph', cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('Markdown input rules', () => {
  const cases = [
    ['# ', 'h1'], ['## ', 'h2'], ['### ', 'h3'], ['> ', 'blockquote'],
  ];
  for (const [mk, tag] of cases) {
    it(`"${mk}" makes ${tag}`, () => {
      make('');
      caretEndOf(ed.el.firstElementChild);
      type(`${mk}Tiêu đề`);
      expect(ed.el.querySelector(tag)?.textContent).toBe('Tiêu đề');
      expect(ed.el.textContent).not.toContain('#');
    });
  }

  it('"- " / "* " bullet, "1. " numbered, "[] " and "[x] " checklist', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('- a');
    expect(md()).toBe('- a');
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('* a');
    expect(md()).toBe('- a');
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('1. một');
    expect(md()).toBe('1. một');
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('[] việc');
    expect(md()).toBe('- [ ] việc');
    expect(ed.el.querySelector('ul[data-type="task"] li[data-checked="false"]')).toBeTruthy();
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('[x] xong');
    expect(md()).toBe('- [x] xong');
  });

  it('"---" becomes a divider with a paragraph after it', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('---');
    expect(ed.el.querySelector('hr')).toBeTruthy();
    type('sau');
    expect(md()).toBe('---\n\nsau');
  });

  it('inline marks: **đậm**, _nghiêng_, *nghiêng*, ~~gạch~~, ==tô==, ++gạch dưới++, `mã`', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('**đậm** _nghiêng_ ~~gạch~~ ==tô== `mã` ++dưới++ *xiên*');
    const el = ed.el;
    expect(el.querySelector('strong').textContent).toBe('đậm');
    expect([...el.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['nghiêng', 'xiên']);
    expect(el.querySelector('s').textContent).toBe('gạch');
    expect(el.querySelector('mark').textContent).toBe('tô');
    expect(el.querySelector('code').textContent).toBe('mã');
    expect(el.querySelector('u').textContent).toBe('dưới');
    expect(md()).toBe('**đậm** _nghiêng_ ~~gạch~~ ==tô== `mã` ++dưới++ _xiên_');
  });

  it('text typed after an inline rule is outside the mark', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('**a** b');
    expect(md()).toBe('**a** b');
  });

  it('snake_case and 2*3*4 stay literal', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('snake_case_name 2*3*4');
    expect(ed.el.querySelector('em')).toBeNull();
  });

  it('no rules inside code blocks or while composing (IME)', () => {
    make('```\nx\n```');
    caretIn('x');
    type(' # ');
    expect(ed.el.querySelector('h1')).toBeNull();

    make('');
    caretEndOf(ed.el.firstElementChild);
    ed.el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    nativeInsert('#');
    fire('input', { inputType: 'insertCompositionText', data: '#', isComposing: true });
    nativeInsert(' ');
    fire('input', { inputType: 'insertText', data: ' ', isComposing: true });
    expect(ed.el.querySelector('h1')).toBeNull();
  });

  it('Vietnamese text inserted in one chunk (Unikey / insertText) is kept exactly', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    const s = 'Tiếng Việt có dấu: ắ ằ ẳ ẵ ặ ơ ư đ — Nguyễn Ngọc';
    const ev = fire('beforeinput', { inputType: 'insertText', data: s });
    expect(ev.defaultPrevented).toBe(false);
    nativeInsert(s);
    fire('input', { inputType: 'insertText', data: s });
    expect(md()).toBe(s);
  });

  it('Telex-style backspace + replace sequences type correctly', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('a');
    backspace();
    type('â');
    type('n');
    expect(md()).toBe('ân');
  });
});

describe('Enter / Backspace / Tab', () => {
  it('Enter splits a paragraph; Shift+Enter inserts a line break', () => {
    make('abcd');
    caretIn('abcd', 2);
    enter();
    expect(md()).toBe('ab\n\ncd');
    make('abcd');
    caretIn('abcd', 2);
    enter(true);
    expect(ed.el.querySelector('br')).toBeTruthy();
    expect(md()).toBe('ab\ncd');
  });

  it('Enter at the end of a heading starts a paragraph', () => {
    make('# Tiêu đề');
    caretIn('Tiêu đề');
    enter();
    type('nội dung');
    expect(md()).toBe('# Tiêu đề\n\nnội dung');
  });

  it('list: Enter adds an item, Enter on an empty item leaves the list', () => {
    make('- a');
    caretIn('a');
    enter();
    type('b');
    enter();
    enter();
    type('c');
    expect(md()).toBe('- a\n- b\n\nc');
  });

  it('checklist: Enter makes an unchecked item with its own checkbox', () => {
    make('- [x] một');
    caretIn('một');
    enter();
    type('hai');
    expect(md()).toBe('- [x] một\n- [ ] hai');
    const lis = ed.el.querySelectorAll('li');
    expect(lis[1].querySelector('.rt-check')).toBeTruthy();
    expect(lis[0].querySelector('.rt-check')).toBeTruthy();
  });

  it('Enter in a nested empty item outdents it', () => {
    make('- a\n  - b');
    caretIn('b');
    enter();
    enter();
    type('c');
    expect(md()).toBe('- a\n  - b\n- c');
  });

  it('code block: Enter inserts a newline, three Enters at the end leave it', () => {
    make('```js\nlet a\n```');
    caretIn('let a');
    enter();
    type('b');
    expect(md()).toBe('```js\nlet a\nb\n```');
    enter();
    enter();
    enter();
    type('sau');
    expect(md()).toBe('```js\nlet a\nb\n```\n\nsau');
  });

  it('"```lang" + Enter opens a code block', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('```js');
    enter();
    type('x');
    expect(md()).toBe('```js\nx\n```');
  });

  it('Backspace at the start of a heading / quote / list item turns it into a paragraph', () => {
    make('# Tiêu đề');
    caretIn('Tiêu đề', 0);
    backspace();
    expect(md()).toBe('Tiêu đề');
    make('> trích');
    caretIn('trích', 0);
    backspace();
    expect(md()).toBe('trích');
    make('- a\n- b');
    caretIn('b', 0);
    backspace();
    expect(md()).toBe('- a\n\nb');
  });

  it('Backspace at the start of a paragraph merges it into the previous block', () => {
    make('một\n\nhai');
    caretIn('hai', 0);
    backspace();
    expect(md()).toBe('mộthai');
    make('- a\n\nb');
    caretIn('b', 0);
    backspace();
    expect(md()).toBe('- ab');
    make('trên\n\n---\n\ndưới');
    caretIn('dưới', 0);
    backspace();
    expect(md()).toBe('trên\n\ndưới');
  });

  it('Delete at the end of a block pulls the next one up', () => {
    make('một\n\nhai');
    caretIn('một');
    const ev = fire('beforeinput', { inputType: 'deleteContentForward' });
    expect(ev.defaultPrevented).toBe(true);
    expect(md()).toBe('mộthai');
  });

  it('Tab / Shift+Tab indent and outdent list items', () => {
    make('- a\n- b');
    caretIn('b');
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(md()).toBe('- a\n  - b');
    key('Tab', { shiftKey: true });
    expect(md()).toBe('- a\n- b');
  });

  it('a selection across blocks is deleted and the blocks merged', () => {
    make('một hai\n\nba bốn');
    const s = document.getSelection();
    const r = document.createRange();
    const walker = document.createTreeWalker(ed.el, 4);
    const t1 = walker.nextNode();
    const t2 = walker.nextNode();
    r.setStart(t1, 4);
    r.setEnd(t2, 3);
    s.removeAllRanges();
    s.addRange(r);
    const ev = fire('beforeinput', { inputType: 'deleteContentBackward' });
    expect(ev.defaultPrevented).toBe(true);
    expect(md()).toBe('một bốn');
  });
});

describe('checkboxes', () => {
  it('clicking the checkbox toggles data-checked and emits a change without moving the caret', () => {
    vi.useFakeTimers();
    make('- [ ] việc\n\nkhác');
    caretIn('khác', 2);
    const box = ed.el.querySelector('li .rt-check, li [contenteditable="false"]');
    const md0 = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    box.dispatchEvent(md0);
    expect(md0.defaultPrevented).toBe(true);
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(ed.el.querySelector('li').getAttribute('data-checked')).toBe('true');
    const r = document.getSelection().getRangeAt(0);
    expect(r.startContainer.data).toBe('khác');
    expect(r.startOffset).toBe(2);
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(['- [x] việc\n\nkhác']);
    ed.undo();
    expect(md()).toBe('- [ ] việc\n\nkhác');
  });

  it('Ctrl+Enter toggles the current task item', () => {
    make('- [ ] việc');
    caretIn('việc');
    key('Enter', { ctrlKey: true });
    expect(md()).toBe('- [x] việc');
  });

  it('readOnly ignores checkbox clicks', () => {
    make('- [ ] việc', { readOnly: true });
    ed.el.querySelector('li [contenteditable="false"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(md()).toBe('- [ ] việc');
  });
});

describe('shortcuts and exec', () => {
  it('Ctrl+B / Ctrl+I / Ctrl+U / Ctrl+Shift+X / Ctrl+Shift+H mark the selection', () => {
    make('một hai ba bốn năm');
    selectText('một');
    key('b', { ctrlKey: true, code: 'KeyB' });
    selectText('hai');
    key('i', { ctrlKey: true, code: 'KeyI' });
    selectText('ba');
    key('u', { ctrlKey: true, code: 'KeyU' });
    selectText('bốn');
    key('X', { ctrlKey: true, shiftKey: true, code: 'KeyX' });
    selectText('năm');
    key('H', { ctrlKey: true, shiftKey: true, code: 'KeyH' });
    expect(md()).toBe('**một** _hai_ ++ba++ ~~bốn~~ ==năm==');
  });

  it('Ctrl+Alt+1/2/3 headings, Ctrl+Shift+7/8/9 lists', () => {
    make('x');
    caretIn('x');
    key('1', { ctrlKey: true, altKey: true, code: 'Digit1' });
    expect(md()).toBe('# x');
    key('2', { ctrlKey: true, altKey: true, code: 'Digit2' });
    expect(md()).toBe('## x');
    key('0', { ctrlKey: true, altKey: true, code: 'Digit0' });
    expect(md()).toBe('x');
    key('&', { ctrlKey: true, shiftKey: true, code: 'Digit7' });
    expect(md()).toBe('1. x');
    key('*', { ctrlKey: true, shiftKey: true, code: 'Digit8' });
    expect(md()).toBe('- x');
    key('(', { ctrlKey: true, shiftKey: true, code: 'Digit9' });
    expect(md()).toBe('- [ ] x');
  });

  it('Ctrl+Shift+U cycles UPPER → lower → Title (Vietnamese-aware)', () => {
    make('đường Phố hà nội');
    selectText('đường Phố hà nội');
    key('U', { ctrlKey: true, shiftKey: true, code: 'KeyU' });
    expect(md()).toBe('ĐƯỜNG PHỐ HÀ NỘI');
    key('U', { ctrlKey: true, shiftKey: true, code: 'KeyU' });
    expect(md()).toBe('đường phố hà nội');
    key('U', { ctrlKey: true, shiftKey: true, code: 'KeyU' });
    expect(md()).toBe('Đường Phố Hà Nội');
    key('U', { ctrlKey: true, shiftKey: true, code: 'KeyU' });
    expect(md()).toBe('ĐƯỜNG PHỐ HÀ NỘI');
    // all-lowercase text starts at Title (lower → Title → UPPER, like Word's Shift+F3)
    make('hà nội');
    selectText('hà nội');
    key('U', { ctrlKey: true, shiftKey: true, code: 'KeyU' });
    expect(md()).toBe('Hà Nội');
  });

  it('Ctrl+\\ clears formatting', () => {
    make('## **đậm**');
    selectText('đậm');
    key('\\', { ctrlKey: true, code: 'Backslash' });
    expect(md()).toBe('đậm');
  });

  it('collapsed Ctrl+B makes the next typed text bold (pending marks)', () => {
    make('a');
    caretIn('a');
    key('b', { ctrlKey: true, code: 'KeyB' });
    type('bc');
    expect(md()).toBe('a**bc**');
  });

  it('Ctrl+K asks for a link (rt:request-link can take over)', () => {
    make('trang chủ');
    selectText('trang chủ');
    ed.el.addEventListener('rt:request-link', (e) => {
      e.preventDefault();
      e.detail.apply('https://example.com');
    }, { once: true });
    key('k', { ctrlKey: true, code: 'KeyK' });
    expect(md()).toBe('[trang chủ](https://example.com)');
  });

  it('exec() maps names and command functions, returns command results', () => {
    make('abc');
    selectText('abc');
    ed.exec('bold');
    expect(md()).toBe('**abc**');
    ed.exec('toggleMark', 'bold');
    expect(md()).toBe('abc');
    ed.exec('setBlock', 'h2');
    expect(md()).toBe('## abc');
    expect(ed.exec('replaceAll', 'abc', 'xyz')).toBe(1);
    expect(md()).toBe('## xyz');
    expect(ed.state().block).toBe('h2');
    expect(() => ed.exec('nope')).toThrow();
  });

  it('exec restores the last editor selection when focus is elsewhere', () => {
    make('một hai');
    selectText('hai');
    document.dispatchEvent(new Event('selectionchange'));
    document.getSelection().removeAllRanges();
    ed.exec('bold');
    expect(md()).toBe('một **hai**');
  });
});

describe('undo / redo', () => {
  it('coalesces typing into one step per word and undoes commands separately', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('xin chào');
    expect(md()).toBe('xin chào');
    ed.undo();
    expect(md()).toBe('xin'); // the serializer trims trailing spaces
    ed.undo();
    expect(md()).toBe('');
    expect(ed.canUndo()).toBe(false);
    ed.redo();
    ed.redo();
    expect(md()).toBe('xin chào');
    expect(ed.canRedo()).toBe(false);
  });

  it('an input rule is its own step (undo shows the literal text)', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('# ');
    expect(ed.el.querySelector('h1')).toBeTruthy();
    ed.undo();
    expect(ed.el.querySelector('h1')).toBeNull();
    expect(md()).toBe('\\#');
  });

  it('Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z and history* inputTypes', () => {
    make('a');
    selectText('a');
    ed.exec('bold');
    key('z', { ctrlKey: true, code: 'KeyZ' });
    expect(md()).toBe('a');
    key('y', { ctrlKey: true, code: 'KeyY' });
    expect(md()).toBe('**a**');
    fire('beforeinput', { inputType: 'historyUndo' });
    expect(md()).toBe('a');
    key('Z', { ctrlKey: true, shiftKey: true, code: 'KeyZ' });
    expect(md()).toBe('**a**');
  });

  it('restores the caret near the edit', () => {
    make('một\n\nhai');
    caretIn('hai');
    type('!');
    ed.undo();
    const r = document.getSelection().getRangeAt(0);
    const b = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    expect(b.textContent).toBe('hai');
  });

  it('keeps at most 200 steps', () => {
    make('');
    for (let i = 0; i < 230; i++) ed.setMarkdown(`v${i}`, { history: 'push' });
    let n = 0;
    while (ed.undo()) n++;
    expect(n).toBe(199);
  });

  it('undo emits onChange with the restored Markdown', () => {
    vi.useFakeTimers();
    make('a');
    selectText('a');
    ed.exec('italic');
    vi.advanceTimersByTime(300);
    ed.undo();
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(['_a_', 'a']);
  });
});

describe('insertMarkdown', () => {
  it('inserts blocks at the caret, splitting the paragraph', () => {
    make('đầu cuối');
    caretIn('đầu cuối', 4);
    ed.insertMarkdown('## Ghi âm\n\n- [ ] việc');
    expect(md()).toBe('đầu\n\n## Ghi âm\n\n- [ ] việc\n\ncuối');
  });

  it('replaces an empty paragraph and appends when there is no caret', () => {
    make('');
    document.getSelection().removeAllRanges();
    ed.insertMarkdown('# A');
    expect(md()).toBe('# A');
    document.getSelection().removeAllRanges();
    ed.insertMarkdown('b');
    expect(md()).toBe('# A\n\nb');
  });

  it('is undoable', () => {
    make('x');
    caretIn('x');
    ed.insertMarkdown('---');
    expect(md()).toBe('x\n\n---');
    ed.undo();
    expect(md()).toBe('x');
  });
});

describe('paste', () => {
  const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head><body>
<!--StartFragment-->
<h1 style="mso-outline-level:1">Báo cáo<o:p></o:p></h1>
<p class=MsoNormal><b><span style='font-family:Calibri'>Đậm</span></b> và <i>nghiêng</i> và <span style='text-decoration:underline'>gạch</span> <span style="background:yellow;mso-highlight:yellow">tô</span><o:p></o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Mục một<o:p></o:p></p>
<p class=MsoListParagraphCxSpLast style='text-indent:-.25in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>o<span>&nbsp;&nbsp; </span></span><![endif]>Mục con<o:p></o:p></p>
<p class=MsoNormal><a href="javascript:alert(1)">xấu</a> <a href="https://vi.wikipedia.org">tốt</a><script>alert(1)</script><img src="x" onerror="alert(1)"></p>
<!--EndFragment--></body></html>`;

  it('sanitizeHtml turns Word HTML into the dialect (no styles, scripts or unsafe links)', () => {
    make('');
    const div = sanitizeHtml(WORD);
    expect(div.querySelector('script,style,[style],[onerror],[class*="Mso"]')).toBeNull();
    const out = htmlToMd(div);
    expect(out).toBe('# Báo cáo\n\n**Đậm** và _nghiêng_ và ++gạch++ ==tô==\n\n- Mục một\n  - Mục con\n\nxấu [tốt](https://vi.wikipedia.org)');
  });

  it('pasting Word HTML inserts the sanitized blocks', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    const ev = paste({ html: WORD, text: 'Báo cáo …' });
    expect(ev.defaultPrevented).toBe(true);
    expect(md()).toContain('# Báo cáo');
    expect(md()).toContain('- Mục một\n  - Mục con');
    expect(ed.el.innerHTML).not.toMatch(/style=|script|onerror|javascript:/i);
  });

  it('Google Docs wrapper <b style="font-weight:normal"> is not bold', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    paste({ html: '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><span style="font-weight:700">A</span><span style="font-weight:400"> b</span></b>' });
    expect(md()).toBe('**A** b');
  });

  it('a single pasted paragraph goes inline at the caret', () => {
    make('ab');
    caretIn('ab', 1);
    paste({ html: '<p>X <strong>Y</strong></p>', text: 'X Y' });
    expect(md()).toBe('aX **Y**b');
  });

  it('plain text with Markdown is parsed; other plain text is literal', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    paste({ text: '# Tiêu đề\n\n- a\n- b' });
    expect(md()).toBe('# Tiêu đề\n\n- a\n- b');
    make('');
    caretEndOf(ed.el.firstElementChild);
    paste({ text: '2*3*4 = 24\ndòng hai' });
    expect(ed.el.querySelector('em')).toBeNull();
    expect(ed.el.textContent).toContain('2*3*4 = 24');
  });

  it('pasting a URL over a selection makes a link', () => {
    make('trang');
    selectText('trang');
    paste({ text: 'https://example.com' });
    expect(md()).toBe('[trang](https://example.com)');
  });

  it('pasting into a code block inserts plain text', () => {
    make('```\na\n```');
    caretIn('a');
    paste({ html: '<b>**x**</b>', text: '**x**' });
    expect(md()).toBe('```\na**x**\n```');
  });

  it('image files go to options.onImageFiles when provided', () => {
    const got = [];
    make('', { onImageFiles: (files, at) => got.push([files, at]) });
    caretEndOf(ed.el.firstElementChild);
    const f = new File(['x'], 'a.png', { type: 'image/png' });
    paste({ files: [f] });
    expect(got.length).toBe(1);
    expect(got[0][0][0]).toBe(f);
    expect(got[0][1]).toHaveProperty('range');
  });

  it('falls back to uploadImage: placeholder then final figure', async () => {
    let resolve;
    make('', { uploadImage: () => new Promise((r) => { resolve = r; }) });
    caretEndOf(ed.el.firstElementChild);
    paste({ files: [new File(['x'], 'a.png', { type: 'image/png' })] });
    await new Promise((r) => setTimeout(r, 0));
    const ph = ed.el.querySelector('figure[data-uploading]');
    expect(ph).toBeTruthy();
    expect(md()).toBe('');
    resolve({ url: 'nm-media:u/n/x.webp' });
    await new Promise((r) => setTimeout(r, 0));
    expect(ed.el.querySelector('figure[data-uploading]')).toBeNull();
    expect(md()).toBe('![](nm-media:u/n/x.webp)');
  });

  it('copy puts dialect HTML + plain text on the clipboard', () => {
    make('**một** hai');
    selectText('một');
    const data = {};
    const ev = new Event('copy', { bubbles: true, cancelable: true });
    ev.clipboardData = { setData: (t, v) => { data[t] = v; } };
    ed.el.dispatchEvent(ev);
    expect(data['text/plain']).toBe('một');
    expect(data['text/html']).toBe('<strong>một</strong>');
  });
});

describe('slash menu', () => {
  it('filters Vietnamese labels without diacritics', () => {
    expect(foldVi('Đường kẻ')).toBe('duong ke');
    expect(filterSlashItems('bang')[0].id).toBe('table');
    expect(filterSlashItems('tieu de 2')[0].id).toBe('h2');
    expect(filterSlashItems('anh')[0].id).toBe('image');
    expect(filterSlashItems('ghi')[0].id).toBe('record');
    expect(filterSlashItems('').length).toBe(SLASH_ITEMS.length);
    expect(SLASH_ITEMS.map((i) => i.label)).toEqual([
      'Tiêu đề 1', 'Tiêu đề 2', 'Tiêu đề 3', 'Danh sách', 'Danh sách số', 'Việc cần làm',
      'Trích dẫn', 'Mã', 'Bảng', 'Đường kẻ', 'Ảnh', 'Ghi âm',
    ]);
  });

  it('"/" at line start opens it; typing filters; Enter applies and removes "/query"', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('/');
    const menu = document.querySelector('.rt-slash');
    expect(menu.hidden).toBe(false);
    expect(ed.el.getAttribute('aria-activedescendant')).toBeTruthy();
    type('tieu de 2');
    expect(menu.querySelector('[aria-selected="true"]').textContent).toContain('Tiêu đề 2');
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(ed.el.querySelector('h2')).toBeTruthy();
    type('Mục');
    expect(md()).toBe('## Mục');
  });

  it('arrow keys move, Escape closes and keeps the text', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('/');
    key('ArrowDown');
    key('ArrowDown');
    const menu = document.querySelector('.rt-slash');
    expect(menu.querySelector('[aria-selected="true"]').textContent).toContain('Tiêu đề 3');
    key('Escape');
    expect(menu.hidden).toBe(true);
    expect(md()).toBe('/');
  });

  it('does not open in the middle of a word (e.g. dates 1/2)', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('1/2');
    expect(document.querySelector('.rt-slash')?.hidden ?? true).toBe(true);
  });

  it('"Ảnh" / "Ghi âm" dispatch rt:request-image / rt:request-record', () => {
    make('');
    const seen = [];
    ed.el.addEventListener('rt:request-image', () => seen.push('image'));
    ed.el.addEventListener('rt:request-record', () => seen.push('record'));
    caretEndOf(ed.el.firstElementChild);
    type('/anh');
    key('Enter');
    type('/ghi');
    key('Enter');
    expect(seen).toEqual(['image', 'record']);
    expect(md()).toBe('');
  });

  it('table and divider items', () => {
    make('');
    caretEndOf(ed.el.firstElementChild);
    type('/bang');
    key('Enter');
    expect(ed.el.querySelector('table th')).toBeTruthy();
    make('a');
    caretIn('a');
    type(' /duong');
    key('Enter');
    expect(ed.el.querySelector('hr')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('looksLikeMarkdown', () => {
    expect(looksLikeMarkdown('# A')).toBe(true);
    expect(looksLikeMarkdown('- a\n- b')).toBe(true);
    expect(looksLikeMarkdown('xem **đậm**')).toBe(true);
    expect(looksLikeMarkdown('[a](https://x.y)')).toBe(true);
    expect(looksLikeMarkdown('Xin chào, hẹn gặp lại 2*3')).toBe(false);
  });

  it('offsetIn / pointAt ignore the checkbox and the placeholder <br>', () => {
    document.body.innerHTML = '<ul><li data-checked="false"><span class="rt-check" contenteditable="false"></span>ab<br></li></ul>';
    const li = document.querySelector('li');
    expect(textOf(li)).toBe('ab');
    const [n, o] = pointAt(li, 0);
    expect(n.data).toBe('ab');
    expect(o).toBe(0);
    expect(offsetIn(li, li, 0)).toBe(0);
    expect(offsetIn(li, li, 2)).toBe(2);
  });
});

describe('pending marks toggle off at a collapsed caret', () => {
  const MARKS = [
    ['bold', '**', () => key('b', { ctrlKey: true, code: 'KeyB' })],
    ['italic', '_', () => key('i', { ctrlKey: true, code: 'KeyI' })],
    ['underline', '++', () => key('u', { ctrlKey: true, code: 'KeyU' })],
    ['strike', '~~', () => key('X', { ctrlKey: true, shiftKey: true, code: 'KeyX' })],
    ['mark', '==', () => key('H', { ctrlKey: true, shiftKey: true, code: 'KeyH' })],
    ['code', '`', () => ed.exec('code')],
  ];
  for (const [name, mk, toggle] of MARKS) {
    it(`${name}: on, type, off, " và thường" stays outside with its leading space`, () => {
      make('');
      caretEndOf(ed.el.firstElementChild);
      type('Xin chào ');
      toggle();
      type('đậm');
      toggle();
      type(' và thường');
      expect(md()).toBe(`Xin chào ${mk}đậm${mk} và thường`);
    });
    it(`${name}: toggling twice before typing is a no-op`, () => {
      make('a');
      caretIn('a');
      toggle();
      toggle();
      type('b');
      expect(md()).toBe('ab');
    });
    it(`${name}: moving the caret clears the pending mark`, () => {
      make('một hai');
      caretIn('một hai');
      toggle();
      caretIn('một hai', 3);
      type('X');
      expect(md()).toBe('mộtX hai');
    });
  }

  it('keepSpaces turns edge / doubled spaces into NBSP only', () => {
    expect(keepSpaces(' a', 'x', '')).toBe(' a');
    expect(keepSpaces(' ', 'x', '')).toBe(' ');
    expect(keepSpaces(' ', 'x', 'y')).toBe(' ');
    expect(keepSpaces('a  b', 'x', 'y')).toBe('a  b');
    expect(keepSpaces(' a', '', 'y')).toBe(' a');
  });
});

describe('transformPastedMarkdown', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('awaits the hook and inserts at the original position while the user keeps typing', async () => {
    let release;
    const seen = [];
    make('ab', {
      transformPastedMarkdown: (m) => {
        seen.push(m);
        return new Promise((r) => { release = () => r(m.replace('Y', 'Z')); });
      },
    });
    caretIn('ab', 1);
    paste({ text: 'X **Y**' });
    await tick();
    expect(seen).toEqual(['X **Y**']);
    expect(md()).toBe('ab'); // the marker is not part of the Markdown
    caretEndOf(ed.el.firstElementChild);
    type('c');
    release();
    await tick();
    await tick();
    expect(md()).toBe('aX **Z**bc');
    expect(ed.el.querySelector('[data-rt-marker]')).toBeNull();
    type('d');
    expect(md()).toBe('aX **Z**bcd');
  });

  it('HTML-derived Markdown goes through the hook too; a sync hook works', async () => {
    make('', { transformPastedMarkdown: (m) => m.replace('nm-media:u/old/', 'nm-media:u/new/') });
    caretEndOf(ed.el.firstElementChild);
    paste({ html: '<p>trên</p><figure class="rt-img" data-src="nm-media:u/old/a.webp"><img alt="mèo"></figure><p>dưới</p>' });
    await tick();
    await tick();
    expect(md()).toBe('trên\n\n![mèo](nm-media:u/new/a.webp)\n\ndưới');
    ed.undo();
    expect(md()).toBe('');
  });

  it('a failing hook falls back to the original Markdown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    make('', { transformPastedMarkdown: () => Promise.reject(new Error('mạng')) });
    caretEndOf(ed.el.firstElementChild);
    paste({ text: '- a' });
    await tick();
    await tick();
    expect(md()).toBe('- a');
    err.mockRestore();
  });

  it('is dropped when the editor was destroyed meanwhile', async () => {
    let release;
    make('x', { transformPastedMarkdown: (m) => new Promise((r) => { release = () => r(m); }) });
    caretIn('x');
    paste({ text: '# y' });
    await tick();
    const el = ed.el;
    ed.destroy();
    ed = null;
    release();
    await tick();
    await tick();
    expect(el.querySelector('h1')).toBeNull();
  });

  it('plain text without Markdown does not wait for the hook', () => {
    const hook = vi.fn((m) => m);
    make('', { transformPastedMarkdown: hook });
    caretEndOf(ed.el.firstElementChild);
    paste({ text: 'chữ thường' });
    expect(md()).toBe('chữ thường');
    expect(hook).not.toHaveBeenCalled();
  });
});
