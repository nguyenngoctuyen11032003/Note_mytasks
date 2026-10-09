// Note media (images, voice recordings) in the private Storage bucket `note-media`.
//
//   object path: <auth.uid()>/<noteId>/<uuid>.<ext>
//   Markdown:    ![alt](nm-media:<path>)   /   [Ghi âm](nm-media:<path>.webm)
//
// This is the ONLY module that calls `supabase.storage`. Reads go through short-lived
// signed URLs (1 h) cached in memory for 50 min; concurrent requests for the same path
// share one request and requests made in the same tick are batched (createSignedUrls).
// Every failure is an AppError: invalid_input, storage_unavailable, forbidden, network,
// server_error, not_found, session_expired.
//
// Lifecycle (wired by the notes page):
//   * uploadImage / uploadAudio bound to the open note id (the note row must exist —
//     the bucket's INSERT policy checks that <noteId> is one of the caller's notes);
//   * pruneUnused(noteId, markdown) after a save that may have dropped media;
//   * deleteNoteMedia(noteId) after a permanent delete, purgeOrphanMedia() after
//     emptying the trash (removes folders whose note no longer exists).
import { AppError, toAppError, db, invalid } from './errors.js';

export const MEDIA_SCHEME = 'nm-media:';
export const BUCKET = 'note-media';
export const IMAGE_MAX_SOURCE = 15 * 1024 * 1024; // before compression
export const AUDIO_MAX = 25 * 1024 * 1024; // = bucket file_size_limit
export const GIF_PASSTHROUGH_MAX = 5 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 1600;
export const SIGNED_URL_TTL = 3600; // seconds
export const CACHE_TTL_MS = 50 * 60 * 1000;
export const PRUNE_MIN_AGE_MS = 10 * 60 * 1000;
const CACHE_CONTROL = '31536000'; // object names are unique (uuid) → immutable
const LIST_PAGE = 1000;
const REMOVE_BATCH = 100;

const STORAGE_DOWN = 'Kho lưu trữ tệp chưa sẵn sàng. Vui lòng thử lại sau.';
const BROKEN_TITLE = 'Không tải được tệp đính kèm (đã bị xóa hoặc bạn không có quyền xem).';
const BROKEN_NET_TITLE = 'Không tải được tệp đính kèm. Kiểm tra mạng và thử lại.';
export const BROKEN_CLASS = 'nm-media-broken';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// nm-media:<uid>/<note>/<file> — no spaces, quotes, brackets or parent segments.
const PATH_RE = /^[0-9A-Za-z_-]+(\/[0-9A-Za-z_.-]+)+$/;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function isMediaUrl(url) {
  return typeof url === 'string' && url.startsWith(MEDIA_SCHEME);
}

/** 'nm-media:a/b/c.webp' → 'a/b/c.webp' (null when not a well-formed media URL). */
export function mediaPath(url) {
  if (!isMediaUrl(url)) return null;
  const p = url.slice(MEDIA_SCHEME.length);
  if (!PATH_RE.test(p) || p.split('/').some((s) => s === '.' || s === '..')) return null;
  return p;
}

/** Every media path referenced in a Markdown string (deduplicated, in order). */
export function referencedPaths(markdown) {
  const out = new Set();
  const re = /nm-media:([0-9A-Za-z_./-]+)/g;
  let m;
  while ((m = re.exec(String(markdown ?? '')))) {
    const p = mediaPath(MEDIA_SCHEME + m[1].replace(/[.]+$/, ''));
    if (p) out.add(p);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Error mapping (Storage API → AppError)
// ---------------------------------------------------------------------------

/** Map a supabase-js Storage error (or anything thrown) to an AppError. */
export function storageError(err) {
  if (err instanceof AppError) return err;
  if (err == null) return new AppError('unknown');
  const msg = String(err.message || '');
  const status = Number(err.status) || Number(err.statusCode) || 0;
  const code = String(err.statusCode || err.code || '');
  const make = (c, m) => new AppError(c, m, { cause: err });

  if (err.name === 'StorageUnknownError' || (!status && /fetch|network|load failed/i.test(msg))) {
    const orig = err.originalError;
    const st = Number(orig?.status) || 0;
    if (st >= 500) return make(st === 500 ? 'server_error' : 'storage_unavailable', st === 500 ? undefined : STORAGE_DOWN);
    return make('network');
  }
  if (/bucket not found/i.test(msg)) return make('storage_unavailable', STORAGE_DOWN);
  if (/row-level security|unauthorized|not authorized|permission denied|access denied/i.test(msg) || status === 403) {
    // 400/403 with an RLS message: the path is not inside the caller's own note.
    return make('forbidden');
  }
  if (/jwt|token.*expired|invalid signature/i.test(msg) || status === 401) return make('session_expired');
  if (status === 413 || /exceeded the maximum allowed size|payload too large|entitytoolarge/i.test(msg + code)) {
    return make('invalid_input', 'Tệp quá lớn (tối đa 25 MB).');
  }
  if (status === 415 || /mime type|invalid_mime_type|not supported/i.test(msg + code)) {
    return make('invalid_input', 'Định dạng tệp không được hỗ trợ.');
  }
  if (/already exists|duplicate/i.test(msg) || status === 409) return make('invalid_input', 'Tệp đã tồn tại.');
  if (status === 404 || /not found|does not exist/i.test(msg)) return make('not_found', 'Không tìm thấy tệp (có thể đã bị xóa).');
  if (status === 400) return make('invalid_input');
  if (status === 502 || status === 503 || status === 504) return make('storage_unavailable', STORAGE_DOWN);
  if (status >= 500) return make('server_error');
  return toAppError(err);
}

async function call(promise) {
  let res;
  try {
    res = await promise;
  } catch (e) {
    throw storageError(e);
  }
  if (res?.error) throw storageError(res.error);
  return res?.data;
}

function bucket() {
  const c = db();
  if (!c.storage) throw new AppError('storage_unavailable', STORAGE_DOWN);
  return c.storage.from(BUCKET);
}

async function currentUid() {
  const c = db();
  let id = null;
  try {
    const { data } = await c.auth.getSession();
    id = data?.session?.user?.id || null;
    if (!id) {
      const r = await c.auth.getUser();
      id = r?.data?.user?.id || null;
    }
  } catch (e) {
    throw toAppError(e);
  }
  if (!id) throw new AppError('session_expired');
  return id;
}

function requireNoteId(noteId) {
  if (typeof noteId !== 'string' || !UUID_RE.test(noteId)) throw invalid('noteId', 'Ghi chú không hợp lệ.');
  return noteId.toLowerCase();
}

function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function folder(noteId) {
  return `${await currentUid()}/${requireNoteId(noteId)}`;
}

const CANCELLED = 'Đã hủy tải lên.';

/** AppError('cancelled') once the caller's AbortSignal fired (e.g. the placeholder was removed). */
function checkAborted(signal) {
  if (signal?.aborted) throw new AppError('cancelled', CANCELLED);
}

async function putObject(path, blob, contentType, signal) {
  checkAborted(signal);
  // storage-js sends a Blob as multipart form data typed by the Blob itself (options.contentType
  // is ignored), and the bucket only allows canonical types → re-type aliases (video/webm,
  // audio/x-m4a, '' …) before sending.
  const body = typeof Blob === 'function' && blob instanceof Blob && blob.type !== contentType
    ? new Blob([blob], { type: contentType })
    : blob;
  await call(bucket().upload(path, body, { contentType, cacheControl: CACHE_CONTROL, upsert: false }));
  if (signal?.aborted) {
    // Upload cannot be aborted mid-flight: drop the object nobody will reference.
    try { await call(bucket().remove([path])); } catch { /* pruneUnused catches leftovers */ }
    throw new AppError('cancelled', CANCELLED);
  }
  return MEDIA_SCHEME + path;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i;

/** Image type from the first bytes (null when not a known raster image). */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const s = (o, str) => [...str].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  if (b[0] === 0x89 && s(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, 'GIF8')) return 'image/gif';
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
  if (s(0, 'BM')) return 'image/bmp';
  if (s(4, 'ftyp') && /^(avif|avis|heic|heix|hevc|mif1|msf1)$/.test(String.fromCharCode(...b.slice(8, 12)))) return 'image/heif';
  return null;
}

/** Pixel size read from the header of a GIF / PNG / WebP (VP8X) file; null otherwise. */
export function headerSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const t = sniffImageType(b);
  if (t === 'image/gif' && b.length >= 10) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (t === 'image/png' && b.length >= 24) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (t === 'image/webp' && b.length >= 30 && String.fromCharCode(...b.slice(12, 16)) === 'VP8X') {
    const u24 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  return null;
}

/** Long side scaled down to `max` (never up). */
export function fitSize(width, height, max = IMAGE_MAX_SIDE) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Validates a picked image before decoding; returns a Vietnamese message or null. */
export function checkImage(file) {
  if (!file || typeof file.size !== 'number') return 'Chưa chọn tệp ảnh.';
  if (!IMAGE_TYPES.test(file.type || '')) return 'Chỉ nhận ảnh PNG, JPG, WebP, GIF hoặc HEIC.';
  if (file.size === 0) return 'Tệp ảnh rỗng.';
  if (file.size > IMAGE_MAX_SOURCE) return 'Ảnh quá lớn (tối đa 15 MB).';
  return null;
}

function canvasBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch { /* fall back to <img> (e.g. HEIC on Safari) */ }
  }
  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') {
    throw invalid('file', 'Trình duyệt không xử lý được ảnh này.');
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(invalid('file', 'Không đọc được ảnh này.')); };
    img.src = url;
  });
}

/**
 * Browser image pipeline: decode (EXIF orientation applied), scale the long side to
 * ≤ 1600 px, re-encode as WebP q0.85 (JPEG q0.85 fallback). Re-encoding drops EXIF
 * (GPS, camera). Returns { blob, type, ext, width, height }.
 */
export async function processImage(file) {
  const img = await decodeImage(file);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) throw invalid('file', 'Không đọc được ảnh này.');
  const { width, height } = fitSize(sw, sh);
  let canvas;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    throw invalid('file', 'Trình duyệt không xử lý được ảnh này.');
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw invalid('file', 'Trình duyệt không xử lý được ảnh này.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  img.close?.();
  const webp = await canvasBlob(canvas, 'image/webp', 0.85);
  if (webp && webp.type === 'image/webp') return { blob: webp, type: 'image/webp', ext: 'webp', width, height };
  const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.85);
  if (!jpeg) throw invalid('file', 'Trình duyệt không nén được ảnh.');
  return { blob: jpeg, type: 'image/jpeg', ext: 'jpg', width, height };
}

const IMAGE_EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

/**
 * Upload an image into the note's folder.
 * `opts.processImage(file) → {blob, type, ext?, width, height}` replaces the canvas
 * pipeline (tests in Node, where there is no canvas).
 * → { url: 'nm-media:…', width, height, bytes }
 */
export async function uploadImage(noteId, file, opts = {}) {
  requireNoteId(noteId);
  const problem = checkImage(file);
  if (problem) throw invalid('file', problem);
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const real = sniffImageType(head);
  if (!real) throw invalid('file', 'Tệp này không phải là ảnh hợp lệ.');

  let out;
  if (real === 'image/gif' && file.size <= GIF_PASSTHROUGH_MAX) {
    // Animated GIFs would lose their animation on a canvas: kept as-is (GIF has no EXIF).
    const size = headerSize(head) || { width: 0, height: 0 };
    out = { blob: file, type: 'image/gif', ext: 'gif', ...size };
  } else {
    checkAborted(opts.signal);
    try {
      out = await (opts.processImage || processImage)(file);
    } catch (e) {
      throw e instanceof AppError ? e : invalid('file', 'Không đọc được ảnh này.');
    }
  }
  checkAborted(opts.signal);
  const type = out?.type;
  if (!out?.blob || !IMAGE_EXT[type]) throw invalid('file', 'Định dạng ảnh không được hỗ trợ.');
  if (out.blob.size > AUDIO_MAX) throw invalid('file', 'Ảnh quá lớn (tối đa 25 MB).');
  const path = `${await folder(noteId)}/${uuid()}.${out.ext || IMAGE_EXT[type]}`;
  const url = await putObject(path, out.blob, type, opts.signal);
  return { url, width: out.width || 0, height: out.height || 0, bytes: out.blob.size };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const AUDIO_TYPES = {
  'audio/webm': ['audio/webm', 'webm'],
  'video/webm': ['audio/webm', 'webm'],
  'audio/ogg': ['audio/ogg', 'ogg'],
  'audio/mp4': ['audio/mp4', 'm4a'],
  'audio/x-m4a': ['audio/mp4', 'm4a'],
  'audio/aac': ['audio/mp4', 'm4a'],
  'video/mp4': ['audio/mp4', 'm4a'],
  'audio/mpeg': ['audio/mpeg', 'mp3'],
  'audio/mp3': ['audio/mpeg', 'mp3'],
  'audio/wav': ['audio/wav', 'wav'],
  'audio/x-wav': ['audio/wav', 'wav'],
  'audio/wave': ['audio/wav', 'wav'],
};

/** 'audio/webm;codecs=opus' → { type: 'audio/webm', ext: 'webm' } (null when unsupported). */
export function audioFormat(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const hit = AUDIO_TYPES[base];
  return hit ? { type: hit[0], ext: hit[1] } : null;
}

/** Upload a recording / audio file. → { url, bytes } */
export async function uploadAudio(noteId, blob, { mimeType, durationSec, signal } = {}) {
  requireNoteId(noteId);
  if (!blob || typeof blob.size !== 'number') throw invalid('file', 'Chưa có tệp âm thanh.');
  const fmt = audioFormat(mimeType || blob.type);
  if (!fmt) throw invalid('file', 'Định dạng âm thanh không được hỗ trợ (WebM, OGG, M4A, MP3, WAV).');
  if (blob.size === 0) throw invalid('file', 'Bản ghi âm rỗng.');
  if (blob.size > AUDIO_MAX) throw invalid('file', 'Tệp âm thanh quá lớn (tối đa 25 MB).');
  if (durationSec != null && !(Number(durationSec) >= 0)) throw invalid('durationSec', 'Thời lượng không hợp lệ.');
  const url = await putObject(`${await folder(noteId)}/${uuid()}.${fmt.ext}`, blob, fmt.type, signal);
  return { url, bytes: blob.size };
}

// ---------------------------------------------------------------------------
// Signed URLs (cache + de-dupe + batching)
// ---------------------------------------------------------------------------

const cache = new Map(); // path → { url, uid, exp, urlExp }
const inflight = new Map(); // `${uid}:${path}` → Promise<string>
let queue = null; // Map `${uid}:${path}` → {path, uid, resolve, reject} for the pending batch

/** Drop cached signed URLs (all, or those under a path prefix). */
export function clearMediaCache(prefix) {
  for (const k of [...cache.keys()]) if (!prefix || k.startsWith(prefix)) cache.delete(k);
}

// Entries belong to the user who signed them: after a sign-out / account switch in the
// same tab, the previous account's URLs (they bypass the bucket policy) are never reused.
function cached(path, uid) {
  const hit = cache.get(path);
  if (hit && hit.uid !== uid) clearMediaCache();
  else if (hit && hit.exp > Date.now()) return hit.url;
  else if (hit) cache.delete(path);
  return null;
}

async function flush(batch) {
  const waiters = [...batch.values()];
  const paths = [...new Set(waiters.map((w) => w.path))];
  const settle = (p, url, err) => {
    for (const w of waiters) {
      if (w.path !== p) continue;
      if (url) {
        const now = Date.now();
        cache.set(p, { url, uid: w.uid, exp: now + CACHE_TTL_MS, urlExp: now + SIGNED_URL_TTL * 1000 });
        w.resolve(url);
      } else w.reject(err);
    }
  };
  try {
    const store = bucket();
    if (paths.length === 1) {
      const data = await call(store.createSignedUrl(paths[0], SIGNED_URL_TTL));
      settle(paths[0], data?.signedUrl, new AppError('not_found', 'Không tìm thấy tệp (có thể đã bị xóa).'));
      return;
    }
    const rows = (await call(store.createSignedUrls(paths, SIGNED_URL_TTL))) || [];
    const byPath = new Map(rows.map((r) => [r.path, r]));
    for (const p of paths) {
      const r = byPath.get(p);
      settle(p, r && !r.error ? r.signedUrl : null,
        r?.error ? storageError({ message: r.error, status: 404 }) : new AppError('not_found', 'Không tìm thấy tệp (có thể đã bị xóa).'));
    }
  } catch (e) {
    for (const p of paths) settle(p, null, storageError(e));
  }
}

function request(path, uid) {
  if (!queue) {
    queue = new Map();
    const batch = queue;
    // Everything requested in this tick (e.g. a hydrateMedia pass) → one API call.
    setTimeout(() => {
      if (queue === batch) queue = null;
      flush(batch);
    }, 0);
  }
  return new Promise((resolve, reject) => queue.set(`${uid}:${path}`, { path, uid, resolve, reject }));
}

async function resolveAs(url, uid) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  const path = mediaPath(url);
  if (!path) throw invalid('url', 'Đường dẫn tệp không hợp lệ.');
  db();
  const me = uid || (await currentUid());
  const hit = cached(path, me);
  if (hit) return hit;
  const key = `${me}:${path}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = request(path, me).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** nm-media URL → signed https URL (cached ~50 min per user). http(s) URLs are returned as-is. */
export function resolveMedia(url) {
  return resolveAs(url, null);
}

/** Resolve many URLs at once → Map(url → signedUrl | AppError). */
export async function resolveMany(urls) {
  const uniq = [...new Set(urls)];
  const uid = await currentUid().catch(() => null); // once for the whole batch
  const res = await Promise.allSettled(uniq.map((u) => resolveAs(u, uid)));
  return new Map(uniq.map((u, i) => [u, res[i].status === 'fulfilled' ? res[i].value : res[i].reason]));
}

const MEDIA_TAGS = new Set(['IMG', 'AUDIO', 'VIDEO', 'SOURCE']);
const MEDIA_SEL = `[data-src^="${MEDIA_SCHEME}"]`;
const RESIGN_MARGIN_MS = 60 * 1000;
const signedUntil = new WeakMap(); // media element → when its signed `src` stops working
const resignedAt = new WeakMap(); // media element → last re-sign after a load error
const watched = new WeakSet();

/** Sign `target`'s file again (cache bypassed) and swap its src; optionally resume playback. */
async function resign(target, play) {
  const holder = target.matches?.(MEDIA_SEL) ? target : target.closest?.(MEDIA_SEL);
  const path = holder && mediaPath(holder.getAttribute('data-src'));
  if (!path) return;
  cache.delete(path);
  await fill(holder);
  if (play && target.getAttribute('src')) target.play?.()?.catch?.(() => {});
}

// Signed URLs live 1 h and audio is preload="none": a note left open longer would play an
// expired URL. `play` re-signs one that is (about to be) expired; `error` (one retry per
// minute and element) covers images loaded late and anything else rejected by Storage.
// Media events do not bubble → capture listeners on the root.
function watch(rootEl) {
  if (watched.has(rootEl) || typeof rootEl.addEventListener !== 'function') return;
  watched.add(rootEl);
  rootEl.addEventListener('play', (e) => {
    const t = e.target;
    const until = signedUntil.get(t);
    if (!until || Date.now() < until - RESIGN_MARGIN_MS) return;
    signedUntil.delete(t);
    t.pause?.();
    resign(t, true).catch(() => {});
  }, true);
  rootEl.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || !MEDIA_TAGS.has(t.tagName) || !signedUntil.has(t)) return;
    const last = resignedAt.get(t) || 0;
    if (Date.now() - last < RESIGN_MARGIN_MS) return; // really broken: hydrate marks it
    resignedAt.set(t, Date.now());
    resign(t, false).catch(() => {});
  }, true);
}

/**
 * Fill the `src` of every `[data-src^="nm-media:"]` img/audio inside rootEl (a wrapper
 * such as `<figure class="rt-img" data-src>` gets its inner img/audio filled). Missing
 * or forbidden files get class `nm-media-broken` + a Vietnamese title. Expired signed
 * URLs are re-signed on play / load error. Never throws.
 * → { resolved, broken }
 */
export async function hydrateMedia(rootEl) {
  if (!rootEl?.querySelectorAll) return { resolved: 0, broken: 0 };
  watch(rootEl);
  return fill(rootEl);
}

async function fill(rootEl) {
  const els = [...rootEl.querySelectorAll(`[data-src^="${MEDIA_SCHEME}"]`)];
  if (rootEl.matches?.(`[data-src^="${MEDIA_SCHEME}"]`)) els.unshift(rootEl);
  const jobs = [];
  for (const el of els) {
    const target = MEDIA_TAGS.has(el.tagName) ? el : el.querySelector('img, audio, video');
    if (!target) continue;
    jobs.push({ el, target, src: el.getAttribute('data-src') });
  }
  if (!jobs.length) return { resolved: 0, broken: 0 };
  let results;
  try {
    results = await resolveMany(jobs.map((j) => j.src));
  } catch (e) {
    const err = e instanceof AppError ? e : storageError(e);
    results = new Map(jobs.map((j) => [j.src, err]));
  }
  let resolved = 0;
  let broken = 0;
  for (const { el, target, src } of jobs) {
    const r = results.get(src);
    if (el.getAttribute('data-src') !== src) continue; // changed meanwhile
    if (typeof r === 'string') {
      if (target.getAttribute('src') !== r) target.setAttribute('src', r);
      const entry = cache.get(mediaPath(src));
      signedUntil.set(target, entry?.url === r ? entry.urlExp : Date.now() + SIGNED_URL_TTL * 1000);
      for (const n of new Set([el, target])) {
        if (n.classList.contains(BROKEN_CLASS)) {
          n.classList.remove(BROKEN_CLASS);
          if (n.getAttribute('title') === BROKEN_TITLE || n.getAttribute('title') === BROKEN_NET_TITLE) n.removeAttribute('title');
        }
      }
      resolved++;
    } else {
      const net = r?.code === 'network' || r?.code === 'storage_unavailable' || r?.code === 'server_error';
      for (const n of new Set([el, target])) {
        n.classList.add(BROKEN_CLASS);
        n.setAttribute('title', net ? BROKEN_NET_TITLE : BROKEN_TITLE);
      }
      target.removeAttribute('src');
      broken++;
    }
  }
  return { resolved, broken };
}

// ---------------------------------------------------------------------------
// Listing / cleanup
// ---------------------------------------------------------------------------

async function listAll(prefix) {
  const store = bucket();
  const out = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const rows = (await call(store.list(prefix, { limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } }))) || [];
    out.push(...rows);
    if (rows.length < LIST_PAGE) break;
  }
  return out;
}

const isFile = (r) => r && r.id != null && r.name !== '.emptyFolderPlaceholder';

/** Files of a note → [{ name, path, url, bytes, type, createdAt }] (name-sorted). */
export async function listNoteMedia(noteId) {
  const dir = await folder(noteId);
  return (await listAll(dir)).filter(isFile).map((r) => ({
    name: r.name,
    path: `${dir}/${r.name}`,
    url: `${MEDIA_SCHEME}${dir}/${r.name}`,
    bytes: Number(r.metadata?.size) || 0,
    type: r.metadata?.mimetype || null,
    createdAt: r.created_at || null,
  }));
}

async function removePaths(paths) {
  const store = bucket();
  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const chunk = paths.slice(i, i + REMOVE_BATCH);
    const rows = await call(store.remove(chunk));
    removed += Array.isArray(rows) ? rows.length : chunk.length;
  }
  for (const p of paths) cache.delete(p);
  return removed;
}

/** Remove every file of a note (permanent delete). → number of files removed. */
export async function deleteNoteMedia(noteId) {
  const dir = await folder(noteId);
  const rows = await listAll(dir);
  const n = await removePaths(rows.filter((r) => r?.name).map((r) => `${dir}/${r.name}`));
  clearMediaCache(dir + '/');
  return n;
}

/** deleteNoteMedia for several notes; best-effort per note. → total files removed. */
export async function deleteMediaForNotes(noteIds) {
  let total = 0;
  for (const id of new Set(noteIds || [])) {
    try { total += await deleteNoteMedia(id); } catch { /* keep going; purgeOrphanMedia catches leftovers */ }
  }
  return total;
}

/**
 * Remove media folders of the caller whose note no longer exists (e.g. after
 * emptyTrash). Trashed notes still exist, so their media is kept.
 * → { notes: number of folders purged, files: number of files removed }
 */
export async function purgeOrphanMedia() {
  const uid = await currentUid();
  const folders = (await listAll(uid)).filter((r) => r && r.id == null && UUID_RE.test(r.name)).map((r) => r.name);
  if (!folders.length) return { notes: 0, files: 0 };
  const live = new Set();
  for (let i = 0; i < folders.length; i += 200) {
    const { data, error } = await db().from('notes').select('id').in('id', folders.slice(i, i + 200));
    if (error) throw toAppError(error);
    for (const r of data || []) live.add(String(r.id).toLowerCase());
  }
  const dead = folders.filter((f) => !live.has(f.toLowerCase()));
  let files = 0;
  for (const id of dead) files += await deleteNoteMedia(id);
  return { notes: dead.length, files };
}

/**
 * Storage's clock (ms), read from the `iat` of a short signed-URL token for `path`
 * (second precision, rounded down → errs on keeping files). Device clock as fallback.
 */
async function serverNow(path) {
  try {
    const data = await call(bucket().createSignedUrl(path, 60));
    const token = new URL(data.signedUrl).searchParams.get('token') || '';
    const body = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const iat = Number(JSON.parse(atob(body)).iat);
    if (iat > 0) return iat * 1000;
  } catch { /* fall back to the device clock */ }
  return Date.now();
}

/**
 * Delete files of this note that the (saved) markdown no longer references and that
 * are older than `minAgeMs` (10 min) — a fresh upload whose markdown is not saved
 * yet is kept. → paths removed.
 */
export async function pruneUnused(noteId, markdown, { minAgeMs = PRUNE_MIN_AGE_MS } = {}) {
  if (typeof markdown !== 'string') throw invalid('markdown', 'Thiếu nội dung ghi chú.');
  const files = await listNoteMedia(noteId);
  const used = new Set(referencedPaths(markdown));
  const unused = files.filter((f) => !used.has(f.path));
  if (!unused.length) return [];
  // created_at is stamped by the server: compare it with the server's clock, not the device's.
  const cutoff = (await serverNow(unused[0].path)) - minAgeMs;
  const stale = unused
    .filter((f) => {
      const t = Date.parse(f.createdAt || '');
      return Number.isFinite(t) && t <= cutoff;
    })
    .map((f) => f.path);
  if (stale.length) await removePaths(stale);
  return stale;
}

/**
 * Copy the caller's media referenced by `markdown` into note `toNoteId` and return
 * the markdown with the URLs rewritten (use when duplicating a note, so deleting the
 * original does not break the copy). Media of other users / missing files are left
 * untouched. When some copies fail, the rest are still made and the AppError carries
 * `details.markdown` (every successful copy already rewritten) and `details.failed`.
 */
export async function copyNoteMedia(markdown, toNoteId) {
  const dir = await folder(toNoteId);
  const uid = dir.split('/')[0];
  let md = String(markdown ?? '');
  const failed = [];
  let error = null;
  for (const p of referencedPaths(md)) {
    if (!p.startsWith(uid + '/') || p.startsWith(dir + '/')) continue;
    const ext = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1) : 'bin';
    const to = `${dir}/${uuid()}.${ext}`;
    try {
      await call(bucket().copy(p, to));
    } catch (e) {
      if (e?.code === 'not_found') continue;
      failed.push(p);
      error = e;
      continue;
    }
    md = md.split(MEDIA_SCHEME + p).join(MEDIA_SCHEME + to);
  }
  if (error) throw new AppError(error.code || 'unknown', error.message, { cause: error, details: { markdown: md, failed } });
  return md;
}
