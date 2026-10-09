// Image UI for the rich Notes editor (stream A5).
//
//   pickImageFile()                           → Promise<File|null>
//   pickImageFiles({ multiple })              → Promise<File[]>
//   insertImages(editor, files, opts)         → Promise<Array<{ file, figure, url, error }>>
//   bindImageUi(editor, { uploadImage, onError }) → { insert(files, opts), select(fig), deselect(), destroy() }
//   openLightbox(src, alt)                    → { el, close() }
//
// DOM contract (docs/rich-editor-design.md):
//   final figure  <figure class="rt-img" contenteditable="false" data-src="nm-media:…" data-w="50"><img alt="…"></figure>
//   placeholder   <figure class="rt-img rt-img--uploading" contenteditable="false" data-uploading="…">…</figure>
// A placeholder has NO data-src: the serializer must skip `figure[data-uploading]`.
// All UI chrome (toolbar, lightbox) lives outside the editor element, so it never
// reaches the Markdown; the caret is never placed inside a figure.

import { html, fragment, raw } from '../../utils/dom.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';

export const WIDTHS = [25, 50, 75, 100];
export const IMAGE_MAX_SOURCE = 15 * 1024 * 1024; // mirrors noteMedia.IMAGE_MAX_SOURCE
const FIG_SEL = 'figure.rt-img';

const IMAGE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5.5-5.5 4 4L16 14l4 4"/></svg>';
const ZOOM_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/></svg>';
const CAPTION_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M6 20h12M8 12h8"/></svg>';

/* ------------------------------------------------------------------ helpers */

const reducedMotion = () => {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
};

function clampWidth(w) {
  const n = Math.round(Number(w));
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(10, n));
}

/** Apply width to a figure: data-w (serialized) + CSS var (display). 100 % = no attribute. */
export function setFigureWidth(fig, w) {
  const n = clampWidth(w);
  if (n == null || n >= 100) {
    fig.removeAttribute('data-w');
    fig.style.removeProperty('--rt-w');
  } else {
    fig.setAttribute('data-w', String(n));
    fig.style.setProperty('--rt-w', `${n}%`);
  }
  if (!fig.getAttribute('style')) fig.removeAttribute('style');
}

export function setFigureAlt(fig, alt) {
  const img = fig.querySelector('img');
  if (img) img.setAttribute('alt', String(alt ?? '').replace(/\s+/g, ' ').trim());
}

/** Build a final image figure (detached). */
export function buildFigure({ src, alt = '', w = null, previewSrc = '' }) {
  const fig = document.createElement('figure');
  fig.className = 'rt-img';
  fig.setAttribute('contenteditable', 'false');
  fig.setAttribute('data-src', src);
  const img = document.createElement('img');
  img.setAttribute('alt', alt);
  img.setAttribute('draggable', 'false');
  // https images can be shown directly; nm-media ones get a signed URL from hydrateMedia,
  // or keep the local preview of the just-uploaded file.
  if (previewSrc) img.src = previewSrc;
  else if (/^https?:\/\//i.test(src)) img.src = src;
  fig.append(img);
  if (w != null) setFigureWidth(fig, w);
  return fig;
}

function emptyParagraph() {
  const p = document.createElement('p');
  p.append(document.createElement('br'));
  return p;
}

function placeCaret(node, atEnd = false) {
  const sel = window.getSelection?.();
  if (!sel || !node) return;
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(!atEnd);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Direct child of root that contains node (or null). */
function topBlock(root, node) {
  let n = node;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n && n.parentNode === root ? n : null;
}

const isFigure = (n) => n?.nodeType === 1 && n.matches(FIG_SEL);
const isEmptyBlock = (n) =>
  n?.nodeType === 1 && /^(P|DIV|H[1-6])$/.test(n.tagName) && !n.textContent.trim() && !n.querySelector('img,figure,audio,hr,table');

/** Caret range from viewport coordinates (drop point). */
export function rangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  }
  return null;
}

function currentRange(root) {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return root.contains(r.startContainer) ? r : null;
}

/**
 * Where to put new block(s): returns { parent, before } for root.insertBefore.
 * Empty paragraph at the caret is replaced; caret at the very start of a block
 * inserts before it; otherwise after the block.
 */
function insertionPoint(root, range) {
  if (!range || !root.contains(range.startContainer) || range.startContainer === root && !root.childNodes.length) {
    return { before: null, replace: null };
  }
  if (range.startContainer === root) return { before: root.childNodes[range.startOffset] || null, replace: null };
  const block = topBlock(root, range.startContainer);
  if (!block) return { before: null, replace: null };
  if (isEmptyBlock(block)) return { before: block, replace: block };
  if (!isFigure(block)) {
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(range.startContainer, range.startOffset);
    if (!pre.toString().length && range.collapsed) return { before: block, replace: null };
  }
  return { before: block.nextSibling, replace: null };
}

/** Tell the editor its content changed (onChange + undo snapshot). */
function notifyChange(editor) {
  if (typeof editor.notifyChange === 'function') editor.notifyChange();
  else editor.el.dispatchEvent(new Event('input', { bubbles: true }));
  editor.el.dispatchEvent(new CustomEvent('rt:image-change', { bubbles: true }));
}

const fileLabel = (f) => (f && f.name) || 'ảnh';
const errMsg = (err) => (typeof err === 'string' ? err : err?.message) || 'Đã có lỗi xảy ra.';

/* ------------------------------------------------------------------ picker */

/** Open the system file picker. `camera: true` asks mobile browsers to open the camera directly. */
export function pickImageFiles({ multiple = true, camera = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = !!multiple;
    if (camera) input.setAttribute('capture', 'environment');
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files);
    };
    // Fallback for browsers without the `cancel` event: when the window regains
    // focus and no file was chosen shortly after, treat as cancelled.
    const onFocus = () => setTimeout(() => { if (!input.files?.length) finish([]); }, 600);
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    setTimeout(() => window.addEventListener('focus', onFocus), 0);
    input.click();
  });
}

export async function pickImageFile(opts = {}) {
  const files = await pickImageFiles({ ...opts, multiple: false });
  return files[0] || null;
}

/* ------------------------------------------------------------------ placeholder */

let uploadSeq = 0;

function placeholderFigure(file, previewUrl) {
  const fig = fragment(html`
    <figure class="rt-img rt-img--uploading" contenteditable="false" data-uploading="${String(++uploadSeq)}" aria-busy="true">
      ${previewUrl ? html`<img alt="" draggable="false" />` : html`<div class="rt-img__blank" aria-hidden="true"></div>`}
      <div class="rt-img__veil">
        <div class="rt-img__status" role="status" aria-live="polite">
          <span class="rt-img__msg">Đang tải ảnh lên…</span>
          <span class="rt-img__name">${fileLabel(file)}</span>
        </div>
        <div class="rt-img__bar" aria-hidden="true"><i></i></div>
        <div class="rt-img__actions">
          <button type="button" class="rt-img__btn" data-rt-act="cancel">${icon('x')}<span>Hủy</span></button>
        </div>
      </div>
    </figure>`);
  if (previewUrl) fig.querySelector('img').src = previewUrl; // set as property: blob: URL
  return fig;
}

function setPlaceholderProgress(fig, ratio) {
  if (!fig.isConnected) return;
  const p = Math.max(0, Math.min(1, Number(ratio) || 0));
  fig.classList.add('has-progress');
  fig.querySelector('.rt-img__bar i')?.style.setProperty('width', `${Math.round(p * 100)}%`);
}

function setPlaceholderError(fig, err) {
  fig.removeAttribute('aria-busy');
  fig.setAttribute('data-error', '');
  fig.classList.remove('has-progress');
  fig.querySelector('.rt-img__msg').textContent = 'Không tải được ảnh';
  fig.querySelector('.rt-img__actions').innerHTML = String(html`
    <button type="button" class="rt-img__btn rt-img__btn--primary" data-rt-act="retry">${icon('refresh')}<span>Thử lại</span></button>
    <button type="button" class="rt-img__btn" data-rt-act="remove">${icon('trash')}<span>Xóa</span></button>`);
  fig.querySelector('.rt-img__name').textContent = errMsg(err);
}

function setPlaceholderUploading(fig) {
  fig.removeAttribute('data-error');
  fig.setAttribute('aria-busy', 'true');
  fig.querySelector('.rt-img__msg').textContent = 'Đang tải ảnh lên…';
  fig.querySelector('.rt-img__actions').innerHTML = String(html`
    <button type="button" class="rt-img__btn" data-rt-act="cancel">${icon('x')}<span>Hủy</span></button>`);
}

/* ------------------------------------------------------------------ insert + upload */

/** Per-editor bookkeeping (object URLs to revoke, pending uploads). */
const STATE = new WeakMap();
function stateOf(editor) {
  let s = STATE.get(editor.el);
  if (!s) {
    s = { urls: new Set(), jobs: new Map() };
    STATE.set(editor.el, s);
  }
  return s;
}

function validate(file) {
  if (!file || !(String(file.type || '').startsWith('image/'))) return `Tệp “${fileLabel(file)}” không phải là ảnh.`;
  if (file.size > IMAGE_MAX_SOURCE) return `Ảnh “${fileLabel(file)}” lớn hơn 15 MB.`;
  return null;
}

/**
 * Insert one placeholder per image file at the caret (or `range`, e.g. the drop point),
 * in order, then upload each; on success the placeholder becomes the final figure.
 * opts: { uploadImage(file, { signal, onProgress }) → Promise<{ url }>, onError(err, file), range, silent }
 */
export function insertImages(editor, files, { uploadImage, onError, range } = {}) {
  const root = editor.el;
  const list = [...(files || [])];
  const accepted = [];
  for (const f of list) {
    const bad = validate(f);
    if (bad) {
      toast.error(bad);
      onError?.(new Error(bad), f);
    } else accepted.push(f);
  }
  if (!accepted.length || typeof uploadImage !== 'function') return Promise.resolve([]);

  const st = stateOf(editor);
  const { before, replace } = insertionPoint(root, range || currentRange(root));
  let anchor = before;
  const figs = accepted.map((file) => {
    let preview = '';
    try { preview = URL.createObjectURL(file); st.urls.add(preview); } catch { /* no object URLs (tests/old browsers) */ }
    const fig = placeholderFigure(file, preview);
    root.insertBefore(fig, anchor);
    return { file, fig, preview };
  });
  if (replace) replace.remove();
  // Always leave a paragraph after the last image so the user can keep typing.
  const last = figs[figs.length - 1].fig;
  let after = last.nextElementSibling;
  if (!after || isFigure(after) || after.matches('table,hr,pre,ul,ol,blockquote')) {
    after = emptyParagraph();
    last.after(after);
  }
  if (root.contains(document.activeElement) || document.activeElement === root) placeCaret(after);

  return Promise.all(figs.map((job) => runUpload(editor, job, { uploadImage, onError })));
}

function runUpload(editor, job, opts) {
  const { uploadImage, onError } = opts;
  const st = stateOf(editor);
  const { file, fig, preview } = job;
  const ctrl = new AbortController();
  const dropPreview = () => {
    if (preview) {
      try { URL.revokeObjectURL(preview); } catch { /* ignore */ }
      st.urls.delete(preview);
    }
  };
  const discard = () => {
    ctrl.abort();
    st.jobs.delete(fig);
    fig.remove();
    dropPreview();
  };
  return new Promise((resolve) => {
    const cancelled = () => {
      discard();
      resolve({ file, figure: null, url: null, error: null, cancelled: true });
    };
    st.jobs.set(fig, { cancel: cancelled, remove: cancelled });

    Promise.resolve()
      .then(() => uploadImage(file, { signal: ctrl.signal, onProgress: (r) => setPlaceholderProgress(fig, r) }))
      .then((res) => {
        if (ctrl.signal.aborted) return;
        const url = res?.url;
        if (!url) throw new Error('Máy chủ không trả về đường dẫn ảnh.');
        st.jobs.delete(fig);
        const final = buildFigure({ src: url, alt: '', previewSrc: preview || '' });
        if (fig.isConnected) fig.replaceWith(final);
        else if (editor.el.isConnected) {
          // Undo / redo / setMarkdown rebuilt the DOM without the placeholder (history
          // snapshots never contain one). The file is stored: keep the image, at the end.
          editor.el.append(final, emptyParagraph());
          toast('Ảnh đã tải xong và được chèn ở cuối ghi chú.');
        } else {
          dropPreview();
          return resolve({ file, figure: null, url: null, error: null, cancelled: true });
        }
        notifyChange(editor);
        resolve({ file, figure: final, url, error: null });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        if (!fig.isConnected) {
          st.jobs.delete(fig);
          dropPreview();
          return resolve({ file, figure: null, url: null, error: err });
        }
        setPlaceholderError(fig, err);
        toast.error(`Không tải được ảnh “${fileLabel(file)}”: ${errMsg(err)}`);
        onError?.(err, file);
        // The failed placeholder stays until the user picks "Thử lại" or "Xóa".
        st.jobs.set(fig, {
          cancel: discard,
          remove: discard,
          retry: () => {
            st.jobs.delete(fig);
            setPlaceholderUploading(fig);
            job.retried = runUpload(editor, job, opts);
          },
        });
        resolve({ file, figure: null, url: null, error: err, placeholder: fig, job });
      });
  });
}

/** Route a placeholder button press (Hủy / Thử lại / Xóa). */
function placeholderAction(editor, fig, act) {
  const h = stateOf(editor).jobs.get(fig);
  if (h && typeof h[act] === 'function') h[act]();
  else if (act === 'remove' || act === 'cancel') fig.remove();
}

/* ------------------------------------------------------------------ lightbox */

let openBox = null;

function safeImageSrc(src) {
  const s = String(src || '').trim();
  if (/^(https?:|blob:)/i.test(s) || /^data:image\//i.test(s) || /^\/(?!\/)/.test(s)) return s;
  return '';
}

function downloadName(src, alt) {
  const base = (alt || '').trim().replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) || 'anh';
  const m = /\.(webp|jpe?g|png|gif)(?:[?#]|$)/i.exec(src || '');
  return `${base}.${m ? m[1].toLowerCase() : 'webp'}`;
}

/** Download an image: fetch → blob (keeps the file name), fall back to opening it. */
export async function downloadImage(src, alt = '') {
  const url = safeImageSrc(src);
  if (!url) return false;
  const a = document.createElement('a');
  a.download = downloadName(url, alt);
  a.rel = 'noopener';
  let blobUrl = '';
  try {
    if (!/^(blob|data):/i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      blobUrl = URL.createObjectURL(await res.blob());
    }
  } catch {
    a.target = '_blank';
  }
  a.href = blobUrl || url;
  document.body.append(a);
  a.click();
  a.remove();
  if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
  return true;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Full-screen image viewer. Esc / Đóng / backdrop closes; Tab is trapped; focus is restored. */
export function openLightbox(src, alt = '') {
  openBox?.close();
  const url = safeImageSrc(src);
  const prevFocus = document.activeElement;
  const el = fragment(html`
    <div class="rt-lightbox" role="dialog" aria-modal="true" aria-label="${alt ? `Ảnh: ${alt}` : 'Xem ảnh'}">
      <div class="rt-lightbox__bar">
        <button type="button" class="rt-lightbox__btn" data-lb="zoom" aria-pressed="false">${raw(ZOOM_ICON)}<span>Kích thước thật</span></button>
        <button type="button" class="rt-lightbox__btn" data-lb="download">${icon('download')}<span>Tải về</span></button>
        <button type="button" class="rt-lightbox__btn" data-lb="close" aria-label="Đóng">${icon('x')}<span>Đóng</span></button>
      </div>
      <div class="rt-lightbox__stage" data-lb="stage">
        <img class="rt-lightbox__img" alt="" draggable="false" />
      </div>
      ${alt ? html`<p class="rt-lightbox__caption">${alt}</p>` : ''}
    </div>`);
  const zoomBtn = el.querySelector('[data-lb="zoom"]');
  const img = el.querySelector('img');
  img.setAttribute('alt', alt || '');
  if (url) img.src = url;
  if (reducedMotion()) el.classList.add('is-static');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.classList.remove('rt-lightbox-open');
    el.remove();
    if (openBox === api) openBox = null;
    if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) prevFocus.focus();
  };
  const setZoom = (actual) => {
    el.classList.toggle('is-actual', actual);
    zoomBtn.setAttribute('aria-pressed', String(actual));
    zoomBtn.querySelector('span').textContent = actual ? 'Vừa màn hình' : 'Kích thước thật';
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const items = [...el.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!el.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb]');
    const act = b?.getAttribute('data-lb');
    if (act === 'close') close();
    else if (act === 'zoom') setZoom(!el.classList.contains('is-actual'));
    else if (act === 'download') downloadImage(url, alt);
    else if (e.target === el || act === 'stage') close(); // backdrop
  });
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    setZoom(!el.classList.contains('is-actual'));
  });
  document.addEventListener('keydown', onKey, true);
  document.documentElement.classList.add('rt-lightbox-open');
  document.body.append(el);
  el.querySelector('[data-lb="close"]').focus();
  const api = { el, close };
  openBox = api;
  return api;
}

/* ------------------------------------------------------------------ figure toolbar + selection */

/**
 * Wire image interactions on an editor ({ el } from createRichEditor).
 * opts: { uploadImage(file, { signal, onProgress }) → Promise<{ url }>, onError(err, file) }
 */
export function bindImageUi(editor, { uploadImage, onError } = {}) {
  const root = editor.el;
  const st = stateOf(editor);
  let selected = null;
  let mode = 'tools'; // 'tools' | 'alt'
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  const bar = document.createElement('div');
  bar.className = 'rt-imgbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Công cụ ảnh');
  bar.hidden = true;
  document.body.append(bar);

  const toolsTpl = () => {
    const w = Number(selected?.getAttribute('data-w')) || 100;
    return html`
      <button type="button" class="rt-imgbar__btn" data-img="alt" title="Chú thích (văn bản thay thế)">${raw(CAPTION_ICON)}<span>Chú thích</span></button>
      <span class="rt-imgbar__sep" aria-hidden="true"></span>
      <div class="rt-imgbar__group" role="group" aria-label="Độ rộng ảnh">
        ${WIDTHS.map((n) => html`<button type="button" class="rt-imgbar__btn rt-imgbar__btn--w" data-img="w" data-w="${n}" aria-pressed="${n === w}" aria-label="Độ rộng ${n}%">${n}%</button>`)}
      </div>
      <span class="rt-imgbar__sep" aria-hidden="true"></span>
      <button type="button" class="rt-imgbar__btn" data-img="view" aria-label="Xem ảnh lớn" title="Xem ảnh lớn">${icon('expand')}</button>
      <button type="button" class="rt-imgbar__btn" data-img="download" aria-label="Tải về" title="Tải về">${icon('download')}</button>
      <button type="button" class="rt-imgbar__btn rt-imgbar__btn--danger" data-img="delete" aria-label="Xóa ảnh" title="Xóa ảnh">${icon('trash')}</button>`;
  };
  const altTpl = () => html`
    <label class="rt-imgbar__alt">
      <span class="sr-only">Chú thích ảnh</span>
      <input type="text" class="rt-imgbar__input" data-img="alt-input" maxlength="300" placeholder="Mô tả ảnh (chú thích)…" value="${selected?.querySelector('img')?.getAttribute('alt') || ''}" />
    </label>
    <button type="button" class="rt-imgbar__btn rt-imgbar__btn--primary" data-img="alt-save">${icon('check')}<span>Lưu</span></button>
    <button type="button" class="rt-imgbar__btn" data-img="alt-cancel">Hủy</button>`;

  // innerHTML with our own escaped templates only (icons are static strings).
  const renderBar = () => {
    bar.innerHTML = String(mode === 'alt' ? altTpl() : toolsTpl());
    bar.classList.toggle('is-alt', mode === 'alt');
  };

  const position = () => {
    if (!selected || bar.hidden) return;
    const r = selected.getBoundingClientRect();
    const bw = bar.offsetWidth || 320;
    const bh = bar.offsetHeight || 48;
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    let top = r.top - bh - 8;
    if (top < 8) top = Math.min(r.bottom + 8, (window.innerHeight || 800) - bh - 8);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, vw - bw - 8));
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(left)}px`;
  };

  function select(fig) {
    if (!fig || !root.contains(fig) || fig.hasAttribute('data-uploading')) return;
    if (selected !== fig) deselect();
    selected = fig;
    fig.classList.add('is-selected');
    fig.setAttribute('aria-selected', 'true');
    mode = 'tools';
    renderBar();
    bar.hidden = false;
    // No caret inside (or around) the figure while it is selected.
    window.getSelection?.()?.removeAllRanges();
    if (document.activeElement !== root && !bar.contains(document.activeElement)) root.focus?.({ preventScroll: true });
    position();
  }

  function deselect() {
    if (!selected) return;
    selected.classList.remove('is-selected');
    selected.removeAttribute('aria-selected');
    selected = null;
    mode = 'tools';
    bar.hidden = true;
  }

  /** Paragraph after `fig` (created when the next block is missing or not text-like). */
  function blockAfter(fig, create = true) {
    const n = fig.nextElementSibling;
    if (n && !isFigure(n)) return n;
    if (!create) return null;
    const p = emptyParagraph();
    fig.after(p);
    return p;
  }
  function blockBefore(fig, create = true) {
    const n = fig.previousElementSibling;
    if (n && !isFigure(n)) return n;
    if (!create) return null;
    const p = emptyParagraph();
    fig.before(p);
    return p;
  }

  function removeFigure(fig) {
    const next = fig.nextElementSibling;
    const prev = fig.previousElementSibling;
    if (fig === selected) deselect();
    fig.remove();
    let target = next && !isFigure(next) ? next : prev && !isFigure(prev) ? prev : null;
    if (!target) {
      target = emptyParagraph();
      if (next) root.insertBefore(target, next);
      else root.append(target);
    }
    root.focus?.({ preventScroll: true });
    placeCaret(target, target === prev);
    notifyChange(editor);
  }

  function leave(fig, forward, createBlock = false) {
    deselect();
    const target = forward
      ? createBlock ? (() => { const p = emptyParagraph(); fig.after(p); return p; })() : blockAfter(fig)
      : blockBefore(fig);
    root.focus?.({ preventScroll: true });
    placeCaret(target, !forward);
    if (createBlock) notifyChange(editor);
    return target;
  }

  /* --- events on the editor --- */

  listen(root, 'mousedown', (e) => {
    const fig = e.target.closest?.(FIG_SEL);
    if (!fig || !root.contains(fig)) return;
    if (e.target.closest('[data-rt-act]')) { e.preventDefault(); return; }
    if (fig.hasAttribute('data-uploading')) { e.preventDefault(); return; }
    e.preventDefault(); // keep the caret out of the figure
    select(fig);
  });
  listen(root, 'click', (e) => {
    const btn = e.target.closest?.('[data-rt-act]');
    const fig = e.target.closest?.(FIG_SEL);
    if (btn && fig) {
      e.preventDefault();
      e.stopPropagation();
      placeholderAction(editor, fig, btn.getAttribute('data-rt-act'));
      return;
    }
    if (fig && !fig.hasAttribute('data-uploading')) {
      e.preventDefault();
      select(fig);
    }
  });
  listen(root, 'dblclick', (e) => {
    const fig = e.target.closest?.(FIG_SEL);
    if (!fig || fig.hasAttribute('data-uploading')) return;
    e.preventDefault();
    view(fig);
  });
  listen(root, 'rt:request-image', (e) => {
    const range = currentRange(root)?.cloneRange() || null;
    const camera = !!e.detail?.camera;
    pickImageFiles({ multiple: !camera, camera }).then((files) => {
      if (files.length) insert(files, { range });
    });
  });

  // Outside click deselects.
  listen(document, 'mousedown', (e) => {
    if (!selected) return;
    if (bar.contains(e.target) || selected.contains(e.target)) return;
    deselect();
  }, true);

  // Keyboard: capture on document so it runs before the editor's own handlers.
  listen(document, 'keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const inBar = bar.contains(e.target);
    if (selected && inBar) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (mode === 'alt') { mode = 'tools'; renderBar(); }
        root.focus?.({ preventScroll: true });
        window.getSelection?.()?.removeAllRanges();
      } else if (e.key === 'Enter' && e.target.matches('[data-img="alt-input"]')) {
        e.preventDefault();
        e.stopPropagation();
        saveAlt();
      }
      return;
    }
    if (!root.contains(e.target) && e.target !== root) return;

    if (selected) {
      const fig = selected;
      if (!root.contains(fig)) { deselect(); return; }
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          stop();
          removeFigure(fig);
          return;
        case 'Enter':
          stop();
          leave(fig, true, true);
          return;
        case 'ArrowDown':
        case 'ArrowRight':
          stop();
          leave(fig, true);
          return;
        case 'ArrowUp':
        case 'ArrowLeft':
          stop();
          leave(fig, false);
          return;
        case 'Escape':
          stop();
          leave(fig, true);
          return;
        case 'Tab':
          if (!e.shiftKey) {
            stop();
            bar.querySelector('button,input')?.focus();
          }
          return;
        default:
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key && e.key.length === 1) leave(fig, true); // typing continues below the image
          return;
      }
    }

    // Caret next to a figure: Backspace at block start / Delete at block end selects it.
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const r = currentRange(root);
    if (!r || !r.collapsed) return;
    const block = topBlock(root, r.startContainer);
    if (!block || isFigure(block)) return;
    const probe = document.createRange();
    probe.selectNodeContents(block);
    if (e.key === 'Backspace') {
      probe.setEnd(r.startContainer, r.startOffset);
      if (probe.toString().length) return;
      const prev = block.previousElementSibling;
      if (!isFigure(prev) || prev.hasAttribute('data-uploading')) return;
      e.preventDefault();
      e.stopPropagation();
      if (isEmptyBlock(block) && block.nextElementSibling) { block.remove(); notifyChange(editor); }
      select(prev);
    } else {
      probe.setStart(r.startContainer, r.startOffset);
      if (probe.toString().length) return;
      const next = block.nextElementSibling;
      if (!isFigure(next) || next.hasAttribute('data-uploading')) return;
      e.preventDefault();
      e.stopPropagation();
      select(next);
    }
  }, true);

  // Deselect when the figure disappears (undo, setMarkdown, …).
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => {
      if (selected && !root.contains(selected)) deselect();
      else position();
    });
    mo.observe(root, { childList: true, subtree: true });
    cleanups.push(() => mo.disconnect());
  }
  listen(window, 'resize', position);
  listen(window, 'scroll', position, true);

  /* --- toolbar actions --- */

  function saveAlt() {
    if (!selected) return;
    const input = bar.querySelector('[data-img="alt-input"]');
    const before = selected.querySelector('img')?.getAttribute('alt') || '';
    setFigureAlt(selected, input?.value || '');
    mode = 'tools';
    renderBar();
    position();
    root.focus?.({ preventScroll: true });
    window.getSelection?.()?.removeAllRanges();
    if ((selected.querySelector('img')?.getAttribute('alt') || '') !== before) notifyChange(editor);
  }

  function setWidth(n) {
    if (!selected) return;
    const before = selected.getAttribute('data-w');
    setFigureWidth(selected, n);
    renderBar();
    position();
    if (selected.getAttribute('data-w') !== before) notifyChange(editor);
  }

  function view(fig) {
    const img = fig.querySelector('img');
    openLightbox(img?.currentSrc || img?.src || fig.getAttribute('data-src'), img?.getAttribute('alt') || '');
  }

  bar.addEventListener('mousedown', (e) => {
    if (!e.target.closest('input')) e.preventDefault(); // keep editor focus / no caret jump
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-img]');
    if (!b || !selected) return;
    const act = b.getAttribute('data-img');
    if (act === 'alt') {
      mode = 'alt';
      renderBar();
      position();
      const input = bar.querySelector('input');
      input?.focus();
      input?.select?.();
    } else if (act === 'alt-save') saveAlt();
    else if (act === 'alt-cancel') {
      mode = 'tools';
      renderBar();
      root.focus?.({ preventScroll: true });
    } else if (act === 'w') setWidth(Number(b.getAttribute('data-w')));
    else if (act === 'view') view(selected);
    else if (act === 'download') {
      const img = selected.querySelector('img');
      downloadImage(img?.currentSrc || img?.src, img?.getAttribute('alt') || '').then((ok) => {
        if (!ok) toast.error('Ảnh chưa sẵn sàng để tải về.');
      });
    } else if (act === 'delete') removeFigure(selected);
  });

  function insert(files, opts = {}) {
    return insertImages(editor, files, { uploadImage, onError, ...opts });
  }

  return {
    insert,
    select,
    deselect,
    get selected() { return selected; },
    toolbar: bar,
    destroy() {
      deselect();
      cleanups.forEach((fn) => fn());
      bar.remove();
      openBox?.close();
      for (const u of st.urls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
      st.urls.clear();
    },
  };
}
