// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  insertImages,
  bindImageUi,
  openLightbox,
  buildFigure,
  setFigureWidth,
  setFigureAlt,
  pickImageFile,
} from '../../src/components/rich/images.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const imgFile = (name = 'a.png', type = 'image/png') => new File(['x'], name, { type });

function makeEditor(htmlStr = '<p>Hello</p><p><br></p>') {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  el.innerHTML = htmlStr;
  document.body.append(el);
  return { el, notifyChange: vi.fn() };
}
function caretIn(node, offset = 0) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}
const key = (target, k, extra = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.body.innerHTML = '<div id="toasts"></div>';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('placeholder lifecycle', () => {
  it('inserts a placeholder at the caret, then the final figure on success', async () => {
    const ed = makeEditor();
    caretIn(ed.el.children[1], 0); // empty paragraph → replaced
    const d = deferred();
    const uploadImage = vi.fn(() => d.promise);
    const done = insertImages(ed, [imgFile()], { uploadImage });

    const ph = ed.el.querySelector('figure.rt-img[data-uploading]');
    expect(ph).toBeTruthy();
    expect(ph.getAttribute('contenteditable')).toBe('false');
    expect(ph.hasAttribute('data-src')).toBe(false);
    expect(ph.textContent).toContain('Đang tải ảnh lên');
    expect(ed.el.children[0].textContent).toBe('Hello');
    expect(ed.el.children[1]).toBe(ph);
    expect(ed.el.children[2].tagName).toBe('P'); // paragraph to keep typing
    await tick();
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadImage.mock.calls[0][1].signal).toBeDefined();

    d.resolve({ url: 'nm-media:u/n/x.webp', width: 10, height: 10 });
    const [res] = await done;
    expect(res.url).toBe('nm-media:u/n/x.webp');
    const fig = ed.el.querySelector('figure.rt-img');
    expect(fig.hasAttribute('data-uploading')).toBe(false);
    expect(fig.getAttribute('data-src')).toBe('nm-media:u/n/x.webp');
    expect(fig.getAttribute('contenteditable')).toBe('false');
    expect(fig.querySelector('img').getAttribute('alt')).toBe('');
    expect(fig.querySelector('.rt-img__veil')).toBeNull();
    expect(ed.notifyChange).toHaveBeenCalled();
  });

  it('keeps multiple files in order and fires input when the editor has no notifyChange', async () => {
    const ed = makeEditor('<p>Hello</p>');
    delete ed.notifyChange;
    const onInput = vi.fn();
    ed.el.addEventListener('input', onInput);
    caretIn(ed.el.firstChild.firstChild, 5); // end of "Hello" → insert after
    const uploads = [deferred(), deferred(), deferred()];
    let i = 0;
    const done = insertImages(ed, [imgFile('1.png'), imgFile('2.png'), imgFile('3.png')], { uploadImage: () => uploads[i++].promise });
    expect(ed.el.querySelectorAll('figure[data-uploading]').length).toBe(3);
    // resolve out of order
    uploads[2].resolve({ url: 'nm-media:c' });
    uploads[0].resolve({ url: 'nm-media:a' });
    uploads[1].resolve({ url: 'nm-media:b' });
    await done;
    const srcs = [...ed.el.querySelectorAll('figure.rt-img')].map((f) => f.dataset.src);
    expect(srcs).toEqual(['nm-media:a', 'nm-media:b', 'nm-media:c']);
    expect(ed.el.firstElementChild.textContent).toBe('Hello');
    expect(ed.el.lastElementChild.tagName).toBe('P');
    expect(onInput).toHaveBeenCalled();
  });

  it('inserts at a given drop range', async () => {
    const ed = makeEditor('<p>A</p><p>B</p>');
    const r = document.createRange();
    r.setStart(ed.el.children[1].firstChild, 0);
    r.collapse(true);
    await insertImages(ed, [imgFile()], { uploadImage: async () => ({ url: 'nm-media:x' }), range: r });
    expect([...ed.el.children].map((n) => n.tagName)).toEqual(['P', 'FIGURE', 'P']);
    expect(ed.el.children[2].textContent).toBe('B');
  });

  it('rejects non-image files with a Vietnamese toast', async () => {
    const ed = makeEditor();
    const uploadImage = vi.fn();
    const onError = vi.fn();
    const res = await insertImages(ed, [new File(['x'], 'a.pdf', { type: 'application/pdf' })], { uploadImage, onError });
    expect(res).toEqual([]);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(document.getElementById('toasts').textContent).toContain('không phải là ảnh');
  });

  it('shows an error state with Thử lại / Xóa and a toast; retry succeeds', async () => {
    const ed = makeEditor();
    const ui = bindImageUi(ed, {});
    caretIn(ed.el.children[1], 0);
    const onError = vi.fn();
    const uploadImage = vi.fn()
      .mockRejectedValueOnce(new Error('Mất kết nối mạng.'))
      .mockResolvedValueOnce({ url: 'nm-media:ok' });
    const [res] = await insertImages(ed, [imgFile('anh.png')], { uploadImage, onError });
    expect(res.error.message).toBe('Mất kết nối mạng.');
    expect(onError).toHaveBeenCalledTimes(1);
    const ph = ed.el.querySelector('figure[data-uploading]');
    expect(ph.hasAttribute('data-error')).toBe(true);
    expect(ph.textContent).toContain('Không tải được ảnh');
    const retry = ph.querySelector('[data-rt-act="retry"]');
    expect(retry.textContent).toContain('Thử lại');
    expect(ph.querySelector('[data-rt-act="remove"]').textContent).toContain('Xóa');
    expect(document.getElementById('toasts').textContent).toContain('anh.png');

    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ph.hasAttribute('data-error')).toBe(false);
    expect(ph.textContent).toContain('Đang tải ảnh lên');
    await tick();
    await tick();
    expect(ed.el.querySelector('figure[data-uploading]')).toBeNull();
    expect(ed.el.querySelector('figure.rt-img').dataset.src).toBe('nm-media:ok');
    expect(uploadImage).toHaveBeenCalledTimes(2);
    ui.destroy();
  });

  it('Xóa removes a failed placeholder', async () => {
    const ed = makeEditor();
    const ui = bindImageUi(ed, {});
    await insertImages(ed, [imgFile()], { uploadImage: async () => { throw new Error('x'); } });
    const ph = ed.el.querySelector('figure[data-uploading]');
    ph.querySelector('[data-rt-act="remove"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ed.el.querySelector('figure')).toBeNull();
    ui.destroy();
  });

  it('cancel aborts the upload, removes the placeholder and ignores a late result', async () => {
    const ed = makeEditor();
    const ui = bindImageUi(ed, {});
    const d = deferred();
    let signal;
    const done = insertImages(ed, [imgFile()], { uploadImage: (f, o) => { signal = o.signal; return d.promise; } });
    await tick();
    const ph = ed.el.querySelector('figure[data-uploading]');
    ph.querySelector('[data-rt-act="cancel"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(signal.aborted).toBe(true);
    expect(ed.el.querySelector('figure')).toBeNull();
    d.resolve({ url: 'nm-media:late' });
    const [res] = await done;
    expect(res.cancelled).toBe(true);
    await tick();
    expect(ed.el.querySelector('figure')).toBeNull();
    expect(ed.notifyChange).not.toHaveBeenCalled();
    ui.destroy();
  });

  it('shows determinate progress when the uploader reports it', async () => {
    const ed = makeEditor();
    const d = deferred();
    let report;
    insertImages(ed, [imgFile()], { uploadImage: (f, o) => { report = o.onProgress; return d.promise; } });
    await tick();
    report(0.4);
    const ph = ed.el.querySelector('figure[data-uploading]');
    expect(ph.classList.contains('has-progress')).toBe(true);
    expect(ph.querySelector('.rt-img__bar i').style.width).toBe('40%');
    d.resolve({ url: 'nm-media:p' });
  });
});

describe('figure attributes (serializer contract)', () => {
  it('buildFigure / setFigureWidth / setFigureAlt', () => {
    const fig = buildFigure({ src: 'nm-media:a/b.webp', alt: 'Mèo', w: 60 });
    expect(fig.outerHTML).toContain('class="rt-img"');
    expect(fig.getAttribute('contenteditable')).toBe('false');
    expect(fig.dataset.src).toBe('nm-media:a/b.webp');
    expect(fig.dataset.w).toBe('60');
    expect(fig.querySelector('img').getAttribute('alt')).toBe('Mèo');
    setFigureWidth(fig, 100);
    expect(fig.hasAttribute('data-w')).toBe(false);
    setFigureWidth(fig, 3);
    expect(fig.dataset.w).toBe('10');
    setFigureAlt(fig, '  a \n b ');
    expect(fig.querySelector('img').getAttribute('alt')).toBe('a b');
  });

  it('toolbar edits alt and width on the selected figure', () => {
    const ed = makeEditor('<p>x</p><figure class="rt-img" contenteditable="false" data-src="nm-media:a"><img alt=""></figure><p>y</p>');
    const ui = bindImageUi(ed, {});
    const fig = ed.el.querySelector('figure');
    fig.querySelector('img').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(ui.selected).toBe(fig);
    expect(fig.classList.contains('is-selected')).toBe(true);
    const bar = ui.toolbar;
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute('role')).toBe('toolbar');

    bar.querySelector('[data-img="w"][data-w="50"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fig.dataset.w).toBe('50');
    expect(bar.querySelector('[data-w="50"]').getAttribute('aria-pressed')).toBe('true');
    expect(ed.notifyChange).toHaveBeenCalledTimes(1);

    bar.querySelector('[data-img="alt"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = bar.querySelector('[data-img="alt-input"]');
    expect(document.activeElement).toBe(input);
    input.value = 'Sơ đồ <b>hệ thống</b>';
    key(input, 'Enter');
    expect(fig.querySelector('img').getAttribute('alt')).toBe('Sơ đồ <b>hệ thống</b>');
    expect(fig.querySelector('b')).toBeNull();
    expect(ed.notifyChange).toHaveBeenCalledTimes(2);
    expect(bar.querySelector('[data-img="alt-input"]')).toBeNull();

    bar.querySelector('[data-img="w"][data-w="100"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fig.hasAttribute('data-w')).toBe(false);
    ui.destroy();
    expect(document.querySelector('.rt-imgbar')).toBeNull();
  });

  it('Esc in the alt input cancels without changing alt', () => {
    const ed = makeEditor('<figure class="rt-img" contenteditable="false" data-src="nm-media:a"><img alt="cũ"></figure>');
    const ui = bindImageUi(ed, {});
    ui.select(ed.el.querySelector('figure'));
    ui.toolbar.querySelector('[data-img="alt"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = ui.toolbar.querySelector('input');
    input.value = 'mới';
    key(input, 'Escape');
    expect(ed.el.querySelector('img').getAttribute('alt')).toBe('cũ');
    expect(ed.notifyChange).not.toHaveBeenCalled();
    ui.destroy();
  });
});

describe('keyboard on a selected figure', () => {
  const FIG = '<figure class="rt-img" contenteditable="false" data-src="nm-media:a"><img alt=""></figure>';

  it('Delete removes the figure and puts the caret in the next block', () => {
    const ed = makeEditor(`<p>a</p>${FIG}<p>b</p>`);
    const ui = bindImageUi(ed, {});
    ui.select(ed.el.querySelector('figure'));
    const e = key(ed.el, 'Delete');
    expect(e.defaultPrevented).toBe(true);
    expect(ed.el.querySelector('figure')).toBeNull();
    expect(ui.selected).toBeNull();
    expect(ed.notifyChange).toHaveBeenCalled();
    const r = window.getSelection().getRangeAt(0);
    expect(ed.el.children[1].contains(r.startContainer) || r.startContainer === ed.el.children[1]).toBe(true);
    ui.destroy();
  });

  it('Backspace removes; toolbar Xóa removes; lone figure leaves an empty paragraph', () => {
    const ed = makeEditor(FIG);
    const ui = bindImageUi(ed, {});
    ui.select(ed.el.querySelector('figure'));
    key(ed.el, 'Backspace');
    expect(ed.el.innerHTML).toBe('<p><br></p>');

    ed.el.innerHTML = `<p>a</p>${FIG}`;
    ui.select(ed.el.querySelector('figure'));
    ui.toolbar.querySelector('[data-img="delete"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ed.el.querySelector('figure')).toBeNull();
    ui.destroy();
  });

  it('Enter creates a paragraph after the figure; arrows move out without editing', () => {
    const ed = makeEditor(`<p>a</p>${FIG}<p>b</p>`);
    const ui = bindImageUi(ed, {});
    const fig = ed.el.querySelector('figure');
    ui.select(fig);
    key(ed.el, 'Enter');
    expect(fig.nextElementSibling.outerHTML).toBe('<p><br></p>');
    expect(ui.selected).toBeNull();
    let r = window.getSelection().getRangeAt(0);
    expect(fig.nextElementSibling.contains(r.startContainer) || r.startContainer === fig.nextElementSibling).toBe(true);

    ui.select(fig);
    key(ed.el, 'ArrowUp');
    r = window.getSelection().getRangeAt(0);
    expect(ed.el.firstElementChild.contains(r.startContainer) || r.startContainer === ed.el.firstElementChild).toBe(true);
    expect(fig.contains(r.startContainer)).toBe(false);
    expect(ed.el.children.length).toBe(4);
    ui.destroy();
  });

  it('Backspace at the start of the block after a figure selects it', () => {
    const ed = makeEditor(`${FIG}<p>b</p>`);
    const ui = bindImageUi(ed, {});
    caretIn(ed.el.children[1].firstChild, 0);
    const e = key(ed.el.children[1], 'Backspace');
    expect(e.defaultPrevented).toBe(true);
    expect(ui.selected).toBe(ed.el.querySelector('figure'));
    expect(window.getSelection().rangeCount).toBe(0); // caret never inside the figure
    ui.destroy();
  });

  it('mousedown outside deselects; removing the figure externally hides the toolbar', async () => {
    const ed = makeEditor(`<p>a</p>${FIG}`);
    const ui = bindImageUi(ed, {});
    ui.select(ed.el.querySelector('figure'));
    ed.el.firstElementChild.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ui.selected).toBeNull();
    ui.select(ed.el.querySelector('figure'));
    ed.el.querySelector('figure').remove();
    await tick();
    expect(ui.selected).toBeNull();
    expect(ui.toolbar.hidden).toBe(true);
    ui.destroy();
  });
});

describe('openLightbox', () => {
  it('opens an accessible dialog, traps focus, closes on Esc and restores focus', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const lb = openLightbox('https://example.com/a.webp', 'Ảnh <script>');
    const el = document.querySelector('.rt-lightbox');
    expect(el).toBe(lb.el);
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector('img').getAttribute('src')).toBe('https://example.com/a.webp');
    expect(el.querySelector('img').getAttribute('alt')).toBe('Ảnh <script>');
    expect(el.querySelector('.rt-lightbox__caption').textContent).toBe('Ảnh <script>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.contains(document.activeElement)).toBe(true);

    const btns = [...el.querySelectorAll('button')];
    btns[btns.length - 1].focus();
    key(btns[btns.length - 1], 'Tab');
    expect(document.activeElement).toBe(btns[0]);
    key(btns[0], 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(btns[btns.length - 1]);

    key(document.activeElement, 'Escape');
    expect(document.querySelector('.rt-lightbox')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('zoom toggles actual size; Đóng button and backdrop close', () => {
    const lb = openLightbox('blob:abc', '');
    const zoom = lb.el.querySelector('[data-lb="zoom"]');
    zoom.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(lb.el.classList.contains('is-actual')).toBe(true);
    expect(zoom.getAttribute('aria-pressed')).toBe('true');
    lb.el.querySelector('[data-lb="close"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.rt-lightbox')).toBeNull();

    const lb2 = openLightbox('https://e.com/b.png', 'x');
    lb2.el.querySelector('[data-lb="stage"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.rt-lightbox')).toBeNull();
  });

  it('refuses unsafe URLs', () => {
    const lb = openLightbox('javascript:alert(1)', '');
    expect(lb.el.querySelector('img').getAttribute('src')).toBeNull();
    lb.close();
  });

  it('opens from the figure toolbar and on double-click', () => {
    const ed = makeEditor('<figure class="rt-img" contenteditable="false" data-src="nm-media:a"><img alt="Mèo" src="https://e.com/c.webp"></figure>');
    const ui = bindImageUi(ed, {});
    ui.select(ed.el.querySelector('figure'));
    ui.toolbar.querySelector('[data-img="view"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.rt-lightbox img').getAttribute('src')).toBe('https://e.com/c.webp');
    key(document.activeElement, 'Escape');
    ed.el.querySelector('img').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.rt-lightbox .rt-lightbox__caption').textContent).toBe('Mèo');
    ui.destroy();
    expect(document.querySelector('.rt-lightbox')).toBeNull();
  });
});

describe('picker', () => {
  it('pickImageFile resolves with the chosen file and removes the input', async () => {
    const p = pickImageFile();
    const input = document.querySelector('input[type=file]');
    expect(input.accept).toBe('image/*');
    expect(input.multiple).toBe(false);
    const f = imgFile();
    Object.defineProperty(input, 'files', { value: [f] });
    input.dispatchEvent(new Event('change'));
    expect(await p).toBe(f);
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('cancel resolves null; camera sets capture', async () => {
    const p = pickImageFile({ camera: true });
    const input = document.querySelector('input[type=file]');
    expect(input.getAttribute('capture')).toBe('environment');
    input.dispatchEvent(new Event('cancel'));
    expect(await p).toBeNull();
  });

  it('rt:request-image on the editor opens the picker and inserts', async () => {
    const ed = makeEditor('<p>a</p>');
    const uploadImage = vi.fn(async () => ({ url: 'nm-media:r' }));
    const ui = bindImageUi(ed, { uploadImage });
    caretIn(ed.el.firstChild.firstChild, 1);
    ed.el.dispatchEvent(new CustomEvent('rt:request-image', { bubbles: true }));
    const input = document.querySelector('input[type=file]');
    expect(input.multiple).toBe(true);
    Object.defineProperty(input, 'files', { value: [imgFile()] });
    input.dispatchEvent(new Event('change'));
    await tick();
    await tick();
    await tick();
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(ed.el.querySelector('figure.rt-img').dataset.src).toBe('nm-media:r');
    ui.destroy();
  });
});

describe('history restore during an upload', () => {
  it('a placeholder detached by undo/setMarkdown still gets its image (appended), never orphaned', async () => {
    const ed = makeEditor();
    caretIn(ed.el.children[1], 0);
    const d = deferred();
    const done = insertImages(ed, [imgFile()], { uploadImage: () => d.promise });
    await tick();
    // what editor.restore() does: innerHTML from a snapshot without [data-uploading]
    ed.el.innerHTML = '<p>Hello</p>';
    d.resolve({ url: 'nm-media:u/n/x.webp' });
    const [res] = await done;
    expect(res.cancelled).toBeUndefined();
    expect(res.url).toBe('nm-media:u/n/x.webp');
    const fig = ed.el.querySelector('figure.rt-img');
    expect(fig?.dataset.src).toBe('nm-media:u/n/x.webp');
    expect(ed.el.lastElementChild.tagName).toBe('P');
    expect(ed.notifyChange).toHaveBeenCalled();
  });

  it('when the editor itself is gone the result is dropped quietly', async () => {
    const ed = makeEditor();
    caretIn(ed.el.children[1], 0);
    const d = deferred();
    const done = insertImages(ed, [imgFile()], { uploadImage: () => d.promise });
    await tick();
    ed.el.remove();
    d.resolve({ url: 'nm-media:u/n/y.webp' });
    const [res] = await done;
    expect(res.cancelled).toBe(true);
    expect(ed.notifyChange).not.toHaveBeenCalled();
  });
});
