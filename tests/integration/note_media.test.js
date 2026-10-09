// note-media bucket + src/services/noteMedia.js against the REAL local Storage API
// (storage-api behind the local gateway) — never the hosted project.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { Window } from 'happy-dom';
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin, anonClient } from './env.js';
import * as M from '../../src/services/noteMedia.js';
import * as N from '../../src/services/notes.js';

const BUCKET = 'note-media';
const appError = (code) => expect.objectContaining({ name: 'AppError', code });

// 1×1 PNG / 2×3 GIF89a — real bytes so the bucket and the sniffer both accept them.
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
const GIF = Uint8Array.from(Buffer.from('R0lGODlhAgADAIAAAP///wAAACwAAAAAAgADAAACAoRRADs=', 'base64'));
const blobOf = (bytes, type) => new Blob([bytes], { type });
const audioBlob = (n = 2048, type = 'audio/webm') => new Blob([new Uint8Array(n).fill(7)], { type });
// Node has no canvas: the injected pipeline stands in for processImage (re-encode = identity).
const fakeProcess = async (file) => ({ blob: new Blob([await file.arrayBuffer()], { type: 'image/png' }), type: 'image/png', ext: 'png', width: 1, height: 1 });

let A, B, noteA, noteA2, noteB;
const as = (u) => setClient(u.client);
const bucketFiles = async (prefix) => {
  const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw error;
  return data.filter((r) => r.id != null).map((r) => r.name);
};

beforeAll(async () => {
  A = await newUser();
  B = await newUser();
  as(A);
  noteA = (await N.createNote({ title: 'A1', content: '' })).id;
  noteA2 = (await N.createNote({ title: 'A2', content: '' })).id;
  as(B);
  noteB = (await N.createNote({ title: 'B1', content: '' })).id;
});

afterAll(async () => {
  for (const u of [A, B]) {
    if (!u) continue;
    const { data: folders } = await admin.storage.from(BUCKET).list(u.user.id, { limit: 1000 });
    for (const f of folders || []) {
      const files = await bucketFiles(`${u.user.id}/${f.name}`);
      if (files.length) await admin.storage.from(BUCKET).remove(files.map((n) => `${u.user.id}/${f.name}/${n}`));
    }
    await deleteUser(u.user);
  }
});

beforeEach(() => {
  M.clearMediaCache();
  vi.restoreAllMocks();
});

describe('pure helpers', () => {
  it('parses media URLs and references', () => {
    expect(M.isMediaUrl('nm-media:a/b/c.webp')).toBe(true);
    expect(M.isMediaUrl('https://x/y.png')).toBe(false);
    expect(M.mediaPath('nm-media:a/b/c.webp')).toBe('a/b/c.webp');
    expect(M.mediaPath('nm-media:a/../c.webp')).toBe(null);
    expect(M.mediaPath('nm-media:a b/c')).toBe(null);
    const md = '![x](nm-media:u/n/1.webp "w=60")\n[Ghi âm](nm-media:u/n/2.webm). ![y](nm-media:u/n/1.webp)';
    expect(M.referencedPaths(md)).toEqual(['u/n/1.webp', 'u/n/2.webm']);
  });

  it('sniffs image types / sizes and fits the long side to 1600 px', () => {
    expect(M.sniffImageType(PNG)).toBe('image/png');
    expect(M.sniffImageType(GIF)).toBe('image/gif');
    expect(M.sniffImageType(new TextEncoder().encode('hello'))).toBe(null);
    expect(M.headerSize(PNG)).toEqual({ width: 1, height: 1 });
    expect(M.headerSize(GIF)).toEqual({ width: 2, height: 3 });
    expect(M.fitSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(M.fitSize(900, 3200)).toEqual({ width: 450, height: 1600 });
    expect(M.fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('normalises recorder mime types', () => {
    expect(M.audioFormat('audio/webm;codecs=opus')).toEqual({ type: 'audio/webm', ext: 'webm' });
    expect(M.audioFormat('audio/x-m4a')).toEqual({ type: 'audio/mp4', ext: 'm4a' });
    expect(M.audioFormat('audio/mp3')).toEqual({ type: 'audio/mpeg', ext: 'mp3' });
    expect(M.audioFormat('video/quicktime')).toBe(null);
  });

  it('maps Storage errors to AppError codes', () => {
    expect(M.storageError({ name: 'StorageApiError', message: 'Bucket not found', status: 404, statusCode: '404' }).code).toBe('storage_unavailable');
    expect(M.storageError({ name: 'StorageApiError', message: 'new row violates row-level security policy', status: 400, statusCode: '403' }).code).toBe('forbidden');
    expect(M.storageError({ name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' }).code).toBe('not_found');
    expect(M.storageError({ name: 'StorageApiError', message: 'The object exceeded the maximum allowed size', status: 413, statusCode: '413' }).code).toBe('invalid_input');
    expect(M.storageError({ name: 'StorageApiError', message: 'Bad gateway', status: 502 }).code).toBe('storage_unavailable');
    expect(M.storageError({ name: 'StorageApiError', message: 'boom', status: 500 }).code).toBe('server_error');
    expect(M.storageError({ name: 'StorageUnknownError', message: 'fetch failed', originalError: new TypeError('fetch failed') }).code).toBe('network');
  });
});

describe('uploads', () => {
  it('uploads an image (injected resize step) and the signed URL serves the bytes', async () => {
    as(A);
    const r = await M.uploadImage(noteA, blobOf(PNG, 'image/png'), { processImage: fakeProcess });
    expect(r).toEqual({ url: expect.stringMatching(new RegExp(`^nm-media:${A.user.id}/${noteA}/[0-9a-f-]{36}\\.png$`)), width: 1, height: 1, bytes: PNG.length });
    const signed = await M.resolveMedia(r.url);
    expect(signed).toMatch(/^http:\/\/127\.0\.0\.1:54321\/storage\/v1\/object\/sign\/note-media\//);
    const res = await fetch(signed);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('keeps small GIFs as-is (no resize step) with their header size', async () => {
    as(A);
    const processImage = vi.fn();
    const r = await M.uploadImage(noteA, blobOf(GIF, 'image/gif'), { processImage });
    expect(processImage).not.toHaveBeenCalled();
    expect(r).toMatchObject({ width: 2, height: 3, bytes: GIF.length });
    expect(r.url).toMatch(/\.gif$/);
  });

  it('without a canvas (Node) the default pipeline fails cleanly with invalid_input', async () => {
    as(A);
    await expect(M.uploadImage(noteA, blobOf(PNG, 'image/png'))).rejects.toEqual(appError('invalid_input'));
  });

  it('rejects non-images, fake images, empty and > 15 MB sources before any upload', async () => {
    as(A);
    await expect(M.uploadImage(noteA, new Blob(['hi'], { type: 'text/plain' }), { processImage: fakeProcess }))
      .rejects.toMatchObject({ code: 'invalid_input', message: 'Chỉ nhận ảnh PNG, JPG, WebP, GIF hoặc HEIC.' });
    await expect(M.uploadImage(noteA, new Blob(['<svg/>'], { type: 'image/png' }), { processImage: fakeProcess }))
      .rejects.toMatchObject({ code: 'invalid_input', message: 'Tệp này không phải là ảnh hợp lệ.' });
    await expect(M.uploadImage(noteA, new Blob([], { type: 'image/png' }), { processImage: fakeProcess })).rejects.toEqual(appError('invalid_input'));
    const huge = new Blob([PNG, new Uint8Array(M.IMAGE_MAX_SOURCE)], { type: 'image/png' });
    await expect(M.uploadImage(noteA, huge, { processImage: fakeProcess })).rejects.toMatchObject({ code: 'invalid_input', message: 'Ảnh quá lớn (tối đa 15 MB).' });
    await expect(M.uploadImage('not-a-note', blobOf(PNG, 'image/png'), { processImage: fakeProcess })).rejects.toEqual(appError('invalid_input'));
  });

  it('uploads audio with a normalised content type', async () => {
    as(A);
    const r = await M.uploadAudio(noteA, audioBlob(4096, 'audio/webm;codecs=opus'), { mimeType: 'audio/webm;codecs=opus', durationSec: 3 });
    expect(r).toEqual({ url: expect.stringMatching(/\.webm$/), bytes: 4096 });
    const res = await fetch(await M.resolveMedia(r.url));
    expect(res.headers.get('content-type')).toBe('audio/webm');
    expect((await res.arrayBuffer()).byteLength).toBe(4096);
  });

  it('rejects unsupported / empty / > 25 MB audio', async () => {
    as(A);
    await expect(M.uploadAudio(noteA, audioBlob(10, 'video/quicktime'))).rejects.toEqual(appError('invalid_input'));
    await expect(M.uploadAudio(noteA, audioBlob(0))).rejects.toEqual(appError('invalid_input'));
    await expect(M.uploadAudio(noteA, audioBlob(M.AUDIO_MAX + 1))).rejects.toMatchObject({ code: 'invalid_input', message: 'Tệp âm thanh quá lớn (tối đa 25 MB).' });
  });

  it("cannot upload into another user's note (bucket policy → forbidden)", async () => {
    as(A);
    await expect(M.uploadAudio(noteB, audioBlob())).rejects.toEqual(appError('forbidden'));
    await expect(M.uploadAudio('00000000-0000-4000-8000-000000000000', audioBlob())).rejects.toEqual(appError('forbidden'));
    expect(await bucketFiles(`${A.user.id}/${noteB}`)).toEqual([]);
  });

  it('stores aliased audio types under the canonical type the bucket allows', async () => {
    as(A);
    for (const [type, want] of [['audio/x-m4a', 'audio/mp4'], ['video/webm', 'audio/webm'], ['audio/mp3', 'audio/mpeg'], ['audio/x-wav', 'audio/wav']]) {
      const r = await M.uploadAudio(noteA, audioBlob(512, type));
      const res = await fetch(await M.resolveMedia(r.url));
      expect(res.headers.get('content-type')).toBe(want);
    }
    const r = await M.uploadAudio(noteA, audioBlob(512, ''), { mimeType: 'audio/ogg' });
    expect((await fetch(await M.resolveMedia(r.url))).headers.get('content-type')).toBe('audio/ogg');
  });

  it('a cancelled upload (AbortSignal) never leaves an object in the bucket', async () => {
    as(A);
    const note = (await N.createNote({ title: 'abort', content: '' })).id;
    const before = new AbortController();
    before.abort();
    await expect(M.uploadImage(note, blobOf(PNG, 'image/png'), { processImage: fakeProcess, signal: before.signal }))
      .rejects.toEqual(appError('cancelled'));
    const during = new AbortController();
    const slow = async (f) => { const out = await fakeProcess(f); during.abort(); return out; };
    await expect(M.uploadImage(note, blobOf(PNG, 'image/png'), { processImage: slow, signal: during.signal }))
      .rejects.toEqual(appError('cancelled'));
    // aborted while the bytes were on the wire: the stored object is removed again
    const late = new AbortController();
    const proto = Object.getPrototypeOf(A.client.storage.from(BUCKET));
    const upload = proto.upload;
    vi.spyOn(proto, 'upload').mockImplementation(async function (...args) {
      const res = await upload.apply(this, args);
      late.abort();
      return res;
    });
    await expect(M.uploadImage(note, blobOf(PNG, 'image/png'), { processImage: fakeProcess, signal: late.signal }))
      .rejects.toEqual(appError('cancelled'));
    expect(proto.upload).toHaveBeenCalledTimes(1);
    const late2 = new AbortController();
    proto.upload.mockImplementation(async function (...args) {
      const res = await upload.apply(this, args);
      late2.abort();
      return res;
    });
    await expect(M.uploadAudio(note, audioBlob(), { signal: late2.signal })).rejects.toEqual(appError('cancelled'));
    expect(await bucketFiles(`${A.user.id}/${note}`)).toEqual([]);
  });

  it('signed-out callers get session_expired', async () => {
    setClient(anonClient());
    await expect(M.uploadAudio(noteA, audioBlob())).rejects.toEqual(appError('session_expired'));
  });
});

describe('the bucket itself enforces size and type', () => {
  it('rejects a disallowed mime type and a file over 25 MB (raw client), mapped to invalid_input', async () => {
    const store = A.client.storage.from(BUCKET);
    const bad = await store.upload(`${A.user.id}/${noteA}/x.svg`, new Blob(['<svg/>']), { contentType: 'image/svg+xml' });
    expect(bad.error).toBeTruthy();
    expect(M.storageError(bad.error).code).toBe('invalid_input');
    const big = await store.upload(`${A.user.id}/${noteA}/big.webm`, audioBlob(M.AUDIO_MAX + 1024), { contentType: 'audio/webm' });
    expect(big.error).toBeTruthy();
    expect(M.storageError(big.error).code).toBe('invalid_input');
    expect((await bucketFiles(`${A.user.id}/${noteA}`)).some((n) => n === 'x.svg' || n === 'big.webm')).toBe(false);
  });

  it('the bucket is private: no public URL access, anon cannot list', async () => {
    as(A);
    const { url } = await M.uploadAudio(noteA, audioBlob());
    const pub = A.client.storage.from(BUCKET).getPublicUrl(M.mediaPath(url)).data.publicUrl;
    expect((await fetch(pub)).status).toBeGreaterThanOrEqual(400);
    const { data } = await anonClient().storage.from(BUCKET).list(`${A.user.id}/${noteA}`);
    expect(data || []).toEqual([]);
  });
});

describe('cross-user isolation', () => {
  it("B cannot sign, list or delete A's media", async () => {
    as(A);
    const { url } = await M.uploadAudio(noteA, audioBlob());
    M.clearMediaCache();
    as(B);
    await expect(M.resolveMedia(url)).rejects.toEqual(expect.objectContaining({ name: 'AppError' }));
    const err = await M.resolveMedia(url).catch((e) => e);
    expect(['not_found', 'forbidden']).toContain(err.code);
    const { data } = await B.client.storage.from(BUCKET).list(`${A.user.id}/${noteA}`);
    expect(data || []).toEqual([]);
    await B.client.storage.from(BUCKET).remove([M.mediaPath(url)]);
    expect(await bucketFiles(`${A.user.id}/${noteA}`)).toContain(M.mediaPath(url).split('/').pop());
    // B's own service calls only ever touch B's folder
    expect(await M.listNoteMedia(noteA)).toEqual([]);
    expect(await M.deleteNoteMedia(noteA)).toBe(0);
    expect(await bucketFiles(`${A.user.id}/${noteA}`)).toContain(M.mediaPath(url).split('/').pop());
  });
});

describe('signed URL cache across users', () => {
  it("a URL cached for A is never handed to B after an account switch (no manual clear)", async () => {
    as(A);
    const { url } = await M.uploadAudio(noteA, audioBlob());
    expect(await M.resolveMedia(url)).toMatch(/token=/); // cached for A
    as(B); // sign-out + sign-in as B in the same tab
    const err = await M.resolveMedia(url).catch((e) => e);
    expect(err).toEqual(expect.objectContaining({ name: 'AppError' }));
    expect(['not_found', 'forbidden']).toContain(err.code);
    const many = await M.resolveMany([url]);
    expect(many.get(url)).toEqual(expect.objectContaining({ name: 'AppError' }));
    as(A);
    expect(await M.resolveMedia(url)).toMatch(/token=/);
  });
});

describe('signed URL cache', () => {
  it('de-dupes concurrent requests, batches a tick into createSignedUrls and caches', async () => {
    as(A);
    const u1 = (await M.uploadAudio(noteA2, audioBlob())).url;
    const u2 = (await M.uploadAudio(noteA2, audioBlob())).url;
    M.clearMediaCache();
    const proto = Object.getPrototypeOf(A.client.storage.from(BUCKET));
    const one = vi.spyOn(proto, 'createSignedUrl');
    const many = vi.spyOn(proto, 'createSignedUrls');
    const [s1, s1b, s2] = await Promise.all([M.resolveMedia(u1), M.resolveMedia(u1), M.resolveMedia(u2)]);
    expect(s1).toBe(s1b);
    expect(s2).not.toBe(s1);
    expect(one).not.toHaveBeenCalled();
    expect(many).toHaveBeenCalledTimes(1);
    expect(many.mock.calls[0][0].sort()).toEqual([M.mediaPath(u1), M.mediaPath(u2)].sort());
    expect(await M.resolveMedia(u1)).toBe(s1);
    expect(many).toHaveBeenCalledTimes(1);
    M.clearMediaCache();
    await M.resolveMedia(u1);
    expect(one).toHaveBeenCalledTimes(1);
  });

  it('expires entries after 50 minutes', async () => {
    as(A);
    const u = (await M.uploadAudio(noteA2, audioBlob())).url;
    const proto = Object.getPrototypeOf(A.client.storage.from(BUCKET));
    const one = vi.spyOn(proto, 'createSignedUrl');
    const t0 = Date.now();
    await M.resolveMedia(u);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 49 * 60 * 1000);
    await M.resolveMedia(u);
    expect(one).toHaveBeenCalledTimes(1);
    Date.now.mockReturnValue(t0 + 51 * 60 * 1000);
    await M.resolveMedia(u);
    expect(one).toHaveBeenCalledTimes(2);
  });

  it('returns http(s) URLs as-is and rejects malformed media URLs', async () => {
    expect(await M.resolveMedia('https://example.com/a.png')).toBe('https://example.com/a.png');
    await expect(M.resolveMedia('nm-media:../x')).rejects.toEqual(appError('invalid_input'));
    await expect(M.resolveMedia('javascript:alert(1)')).rejects.toEqual(appError('invalid_input'));
  });
});

describe('hydrateMedia (happy-dom)', () => {
  it('fills img/audio (direct and inside figures), marks missing/foreign media broken', async () => {
    as(A);
    const img = (await M.uploadImage(noteA2, blobOf(PNG, 'image/png'), { processImage: fakeProcess })).url;
    const aud = (await M.uploadAudio(noteA2, audioBlob())).url;
    const missing = `nm-media:${A.user.id}/${noteA2}/00000000-0000-4000-8000-000000000000.webp`;
    const foreign = `nm-media:${B.user.id}/${noteB}/00000000-0000-4000-8000-000000000001.webp`;
    const win = new Window();
    const root = win.document.createElement('div');
    root.innerHTML = `
      <img id="i1" data-src="${img}" alt="">
      <figure class="rt-img" data-src="${img}"><img id="i2" alt=""></figure>
      <figure class="rt-audio" data-src="${aud}"><audio id="a1" controls></audio><figcaption>x</figcaption></figure>
      <img id="m1" data-src="${missing}">
      <img id="f1" data-src="${foreign}">
      <img id="ext" src="https://example.com/x.png">`;
    const out = await M.hydrateMedia(root);
    expect(out).toEqual({ resolved: 3, broken: 2 });
    const $ = (id) => root.querySelector('#' + id);
    expect($('i1').getAttribute('src')).toMatch(/\/storage\/v1\/object\/sign\/note-media\//);
    expect($('i2').getAttribute('src')).toBe($('i1').getAttribute('src'));
    expect($('a1').getAttribute('src')).toMatch(/\.webm\?token=/);
    for (const id of ['m1', 'f1']) {
      expect($(id).classList.contains(M.BROKEN_CLASS)).toBe(true);
      expect($(id).getAttribute('title')).toMatch(/Không tải được tệp/);
      expect($(id).hasAttribute('src')).toBe(false);
    }
    expect($('ext').getAttribute('src')).toBe('https://example.com/x.png');
    expect(await M.hydrateMedia(win.document.createElement('div'))).toEqual({ resolved: 0, broken: 0 });
    expect(await M.hydrateMedia(null)).toEqual({ resolved: 0, broken: 0 });
    await win.happyDOM.close();
  });

  it('re-signs an expired URL on play (note left open > 1 h) and once on a load error', async () => {
    as(A);
    const aud = (await M.uploadAudio(noteA2, audioBlob())).url;
    const win = new Window();
    const root = win.document.createElement('div');
    root.innerHTML = `<figure class="rt-audio" data-src="${aud}"><audio id="a1" preload="none" controls></audio></figure>`;
    await M.hydrateMedia(root);
    const a = root.querySelector('#a1');
    expect(a.getAttribute('src')).toMatch(/token=/);
    const proto = Object.getPrototypeOf(A.client.storage.from(BUCKET));
    const one = vi.spyOn(proto, 'createSignedUrl');
    const settle = () => new Promise((r) => setTimeout(r, 100));
    a.dispatchEvent(new win.Event('play')); // still fresh
    await settle();
    expect(one).not.toHaveBeenCalled();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60 * 1000);
    a.dispatchEvent(new win.Event('play'));
    clock.mockRestore();
    await vi.waitFor(() => expect(one).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(a.getAttribute('src')).toMatch(/token=/));
    a.dispatchEvent(new win.Event('error'));
    await vi.waitFor(() => expect(one).toHaveBeenCalledTimes(2));
    a.dispatchEvent(new win.Event('error')); // a file that keeps failing is not re-signed in a loop
    await settle();
    expect(one).toHaveBeenCalledTimes(2);
    await win.happyDOM.close();
  });
});

describe('listing and cleanup', () => {
  it('listNoteMedia returns name, path, url, bytes', async () => {
    as(B);
    const r = await M.uploadAudio(noteB, audioBlob(1500, 'audio/ogg'));
    const list = await M.listNoteMedia(noteB);
    expect(list).toEqual([expect.objectContaining({
      name: M.mediaPath(r.url).split('/').pop(), path: M.mediaPath(r.url), url: r.url, bytes: 1500, type: 'audio/ogg',
    })]);
  });

  it('pruneUnused removes only unreferenced files older than 10 minutes', async () => {
    as(B);
    const note = (await N.createNote({ title: 'prune', content: '' })).id;
    const keep = (await M.uploadAudio(note, audioBlob())).url;
    const drop = (await M.uploadAudio(note, audioBlob())).url;
    const md = `hello\n\n[Ghi âm](${keep})`;
    // fresh uploads are protected even if not referenced (note not saved yet)
    expect(await M.pruneUnused(note, md)).toEqual([]);
    expect(await M.listNoteMedia(note)).toHaveLength(2);
    // a device clock 11 min fast must not make the fresh upload look old (server clock decides)
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 11 * 60 * 1000);
    expect(await M.pruneUnused(note, md)).toEqual([]);
    vi.restoreAllMocks();
    // negative age: the server clock (signed-URL iat) has 1 s precision
    expect(await M.pruneUnused(note, md, { minAgeMs: -60_000 })).toEqual([M.mediaPath(drop)]);
    expect((await M.listNoteMedia(note)).map((f) => f.url)).toEqual([keep]);
    await expect(M.pruneUnused(note, undefined)).rejects.toEqual(appError('invalid_input'));
  });

  it('deleteNoteMedia removes every file of a hard-deleted note in batches of 100', async () => {
    as(B);
    const note = (await N.createNote({ title: 'many', content: '' })).id;
    for (let i = 0; i < 105; i += 15) {
      await Promise.all(Array.from({ length: Math.min(15, 105 - i) }, () => M.uploadAudio(note, audioBlob(16))));
    }
    expect(await M.listNoteMedia(note)).toHaveLength(105);
    const proto = Object.getPrototypeOf(B.client.storage.from(BUCKET));
    const rm = vi.spyOn(proto, 'remove');
    await N.deleteNote(note);
    expect(await M.deleteNoteMedia(note)).toBe(105);
    expect(rm.mock.calls.map((c) => c[0].length)).toEqual([100, 5]);
    expect(await bucketFiles(`${B.user.id}/${note}`)).toEqual([]);
  });

  it('copyNoteMedia duplicates referenced media into another note and rewrites the markdown', async () => {
    as(B);
    const src = (await N.createNote({ title: 'src', content: '' })).id;
    const dst = (await N.createNote({ title: 'dst', content: '' })).id;
    const u = (await M.uploadAudio(src, audioBlob(77))).url;
    const md = `x [rec](${u}) ![e](https://e.com/a.png)`;
    const out = await M.copyNoteMedia(md, dst);
    const [copied] = M.referencedPaths(out);
    expect(copied.startsWith(`${B.user.id}/${dst}/`)).toBe(true);
    expect(out).toContain('https://e.com/a.png');
    expect((await M.listNoteMedia(dst)).map((f) => f.path)).toEqual([copied]);
    await M.deleteNoteMedia(src);
    expect((await fetch(await M.resolveMedia('nm-media:' + copied))).status).toBe(200);
  });

  it('copyNoteMedia keeps the copies already made when one copy fails', async () => {
    as(B);
    const src = (await N.createNote({ title: 'src3', content: '' })).id;
    const dst = (await N.createNote({ title: 'dst3', content: '' })).id;
    const [u1, u2, u3] = [(await M.uploadAudio(src, audioBlob())).url, (await M.uploadAudio(src, audioBlob())).url, (await M.uploadAudio(src, audioBlob())).url];
    const proto = Object.getPrototypeOf(B.client.storage.from(BUCKET));
    const copy = proto.copy;
    let n = 0;
    vi.spyOn(proto, 'copy').mockImplementation(function (...args) {
      if (++n === 2) return Promise.resolve({ data: null, error: { name: 'StorageUnknownError', message: 'fetch failed', originalError: new TypeError('fetch failed') } });
      return copy.apply(this, args);
    });
    const err = await M.copyNoteMedia(`[a](${u1}) [b](${u2}) [c](${u3})`, dst).catch((e) => e);
    expect(err).toEqual(appError('network'));
    expect(err.details.failed).toEqual([M.mediaPath(u2)]);
    const out = err.details.markdown;
    expect(out).toContain(u2);
    expect(out).not.toContain(u1);
    expect(out).not.toContain(u3);
    const copied = M.referencedPaths(out).filter((p) => p.startsWith(`${B.user.id}/${dst}/`));
    expect(copied).toHaveLength(2);
    expect((await M.listNoteMedia(dst)).map((f) => f.path).sort()).toEqual([...copied].sort());
  });

  it('purgeOrphanMedia (after emptyTrash) removes folders of deleted notes only', async () => {
    as(A);
    const live = (await N.createNote({ title: 'live', content: '' })).id;
    const trashed = (await N.createNote({ title: 'trash', content: '' })).id;
    const gone = (await N.createNote({ title: 'gone', content: '' })).id;
    await M.uploadAudio(live, audioBlob());
    await M.uploadAudio(trashed, audioBlob());
    await M.uploadAudio(gone, audioBlob());
    await N.trashNote(trashed);
    await N.trashNote(gone);
    // trashed notes keep their media
    let r = await M.purgeOrphanMedia();
    expect(r.notes).toBe(0);
    await N.restoreNote(trashed);
    await N.emptyTrash();
    r = await M.purgeOrphanMedia();
    expect(r).toEqual({ notes: 1, files: 1 });
    expect(await bucketFiles(`${A.user.id}/${gone}`)).toEqual([]);
    expect(await bucketFiles(`${A.user.id}/${live}`)).toHaveLength(1);
    // B's media untouched
    expect((await bucketFiles(`${B.user.id}/${noteB}`)).length).toBeGreaterThan(0);
  });
});

describe('emptyTrashIds + deleteMediaForNotes (what the notes page wires)', () => {
  it('releases the media of every note removed from the trash', async () => {
    as(B);
    const t1 = (await N.createNote({ title: 't1', content: '' })).id;
    const t2 = (await N.createNote({ title: 't2', content: '' })).id;
    await M.uploadAudio(t1, audioBlob());
    await M.uploadAudio(t2, audioBlob());
    await M.uploadAudio(t2, audioBlob());
    await N.trashNote(t1);
    await N.trashNote(t2);
    const ids = await N.emptyTrashIds();
    expect(ids.sort()).toEqual([t1, t2].sort());
    expect(await M.deleteMediaForNotes(ids)).toBe(3);
    expect(await bucketFiles(`${B.user.id}/${t1}`)).toEqual([]);
    expect(await bucketFiles(`${B.user.id}/${t2}`)).toEqual([]);
    expect(await M.deleteMediaForNotes([])).toBe(0);
  });
});
