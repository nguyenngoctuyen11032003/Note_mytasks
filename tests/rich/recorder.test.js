// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isRecordingSupported, isTranscriptionSupported, openRecorder,
  pickMimeType, baseMime, fmtElapsed, fmtStamp, escapeMd, buildRecordingMarkdown, sortEntries,
  micErrorMessage, levelFromAnalyser, createTranscriber, meetingWhen, fixWebmDuration,
  TRANSITIONS, MAX_SEC, WARN_SEC, AUDIO_BITS, TIMESLICE_MS, MIME_CANDIDATES,
} from '../../src/components/rich/recorder.js';
import { configureDates } from '../../src/utils/date.js';

/* ------------------------------------------------------------------ */
/* Browser API mocks                                                   */
/* ------------------------------------------------------------------ */

let env;

function defineNav(key, value) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

function makeTrack() {
  const listeners = {};
  return {
    kind: 'audio',
    readyState: 'live',
    stop: vi.fn(function stop() { this.readyState = 'ended'; }),
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    fire: (t) => (listeners[t] || []).forEach((f) => f()),
    getSettings: () => ({ deviceId: 'mic-1' }),
  };
}

function installEnv({ supported = [...MIME_CANDIDATES], speech = true, wake = true } = {}) {
  env = {
    supported, recorders: [], tracks: [], streams: [], recognitions: [], contexts: [], locks: [],
    level: 0.25, gumError: null, mrThrowOnMime: false, gumDeferred: null,
  };

  class MockMediaRecorder {
    static isTypeSupported = vi.fn((t) => env.supported.includes(t));
    constructor(stream, opts = {}) {
      if (env.mrThrowOnMime && opts.mimeType) throw new DOMException('unsupported', 'NotSupportedError');
      this.stream = stream;
      this.opts = opts;
      this.mimeType = opts.mimeType || 'audio/webm';
      this.state = 'inactive';
      this.calls = [];
      env.recorders.push(this);
    }
    start(ts) { this.state = 'recording'; this.timeslice = ts; this.calls.push('start'); }
    pause() { this.state = 'paused'; this.calls.push('pause'); }
    resume() { this.state = 'recording'; this.calls.push('resume'); }
    stop() {
      if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError');
      this.state = 'inactive';
      this.calls.push('stop');
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['tail']) });
        this.onstop?.();
      });
    }
    emit(text) { this.ondataavailable?.({ data: new Blob([text]) }); }
  }
  globalThis.MediaRecorder = MockMediaRecorder;

  env.gum = vi.fn(async () => {
    if (env.gumDeferred) await env.gumDeferred.promise;
    if (env.gumError) throw env.gumError;
    const track = makeTrack();
    env.tracks.push(track);
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    env.streams.push(stream);
    return stream;
  });
  env.enumerate = vi.fn(async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Mặc định' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Micro USB' },
    { kind: 'audioinput', deviceId: 'mic-2', label: '' },
    { kind: 'audiooutput', deviceId: 'spk', label: 'Loa' },
  ]);
  defineNav('mediaDevices', { getUserMedia: env.gum, enumerateDevices: env.enumerate });

  class MockAudioContext {
    constructor() {
      this.state = 'running';
      this.close = vi.fn(async () => { this.state = 'closed'; });
      env.contexts.push(this);
    }
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData: (b) => b.fill(env.level) }; }
    resume() { return Promise.resolve(); }
  }
  globalThis.AudioContext = MockAudioContext;

  class MockRecognition {
    constructor() {
      this.results = [];
      this.started = false;
      env.recognitions.push(this);
    }
    start() { this.started = true; }
    stop() { this.started = false; queueMicrotask(() => this.onend?.()); }
    abort() { this.aborted = true; this.started = false; }
    /** Speak: updates the trailing interim result or appends a new one. */
    say(text, isFinal = false) {
      const res = Object.assign([{ transcript: text }], { isFinal });
      const last = this.results[this.results.length - 1];
      let idx;
      if (last && !last.isFinal) { idx = this.results.length - 1; this.results[idx] = res; } else { idx = this.results.length; this.results.push(res); }
      this.onresult?.({ resultIndex: idx, results: this.results });
    }
    end() { this.started = false; this.onend?.(); }
  }
  delete globalThis.SpeechRecognition;
  if (speech) globalThis.webkitSpeechRecognition = MockRecognition;
  else delete globalThis.webkitSpeechRecognition;

  if (wake) {
    defineNav('wakeLock', {
      request: vi.fn(async () => {
        const lock = { released: false, addEventListener() {}, release: vi.fn(async () => { lock.released = true; }) };
        env.locks.push(lock);
        return lock;
      }),
    });
  } else defineNav('wakeLock', undefined);

  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const advance = async (ms) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

const q = (sel) => document.querySelector(sel);
const btn = (a) => q(`dialog.rec [data-act="${a}"]`);
const click = async (a) => { btn(a).click(); await flush(); };
const state = () => q('dialog.rec')?.dataset.state;
const timer = () => q('dialog.rec [data-role="timer"]').textContent;
const lastRec = () => env.recorders[env.recorders.length - 1];
const lastSR = () => env.recognitions[env.recognitions.length - 1];

const opened = [];
function open(extra = {}) {
  const calls = { inserted: [], errors: [] };
  const uploadAudio = extra.uploadAudio || vi.fn(async () => ({ url: 'nm-media:u1/n1/abc.webm', bytes: 10 }));
  const r = openRecorder({
    noteId: 'n1',
    uploadAudio,
    onInsert: (md) => calls.inserted.push(md),
    onError: (e) => calls.errors.push(e),
    ...extra,
  });
  opened.push(r);
  return { r, calls, uploadAudio };
}

async function startRecording(extra) {
  const ctx = open(extra);
  await click('start');
  await flush();
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-09T07:05:00Z')); // 14:05 in Asia/Ho_Chi_Minh
  configureDates({ timezone: 'Asia/Ho_Chi_Minh' });
  document.body.innerHTML = '';
  try { localStorage.clear(); } catch { /* ignore */ }
  installEnv();
});

afterEach(() => {
  opened.splice(0).forEach((r) => r.close());
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe('format helpers', () => {
  it.each([
    [0, '00:00'], [5, '00:05'], [65, '01:05'], [754, '12:34'], [3599, '59:59'],
    [3600, '1:00:00'], [3725, '1:02:05'], [-4, '00:00'], [NaN, '00:00'], [12.9, '00:12'],
  ])('fmtElapsed(%s) = %s', (s, out) => expect(fmtElapsed(s)).toBe(out));

  it.each([[5, '00:05'], [80, '01:20'], [3600, '60:00'], [-1, '00:00']])('fmtStamp(%s) = %s', (s, out) => {
    expect(fmtStamp(s)).toBe(out);
  });

  it('meetingWhen gives HH:MM and dd/MM/yyyy in the user timezone', () => {
    expect(meetingWhen(new Date('2026-10-09T07:05:00Z'))).toEqual({ time: '14:05', date: '09/10/2026' });
    expect(meetingWhen(new Date('2026-10-09T18:30:00Z'))).toEqual({ time: '01:30', date: '10/10/2026' });
  });

  it('baseMime strips codecs', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('Audio/MP4')).toBe('audio/mp4');
    expect(baseMime('')).toBe('');
  });

  it('constants follow the contract', () => {
    expect(MAX_SEC).toBe(3600);
    expect(WARN_SEC).toBe(3300);
    expect(AUDIO_BITS).toBe(32000);
    expect(TIMESLICE_MS).toBe(1000);
  });
});

describe('escapeMd', () => {
  it.each([
    ['*đậm*', '\\*đậm\\*'],
    ['tên_biến', 'tên\\_biến'],
    ['[x](y)', '\\[x\\](y)'],
    ['`mã`', '\\`mã\\`'],
    ['a | b', 'a \\| b'],
    ['C:\\thư mục', 'C:\\\\thư mục'],
    ['a == b', 'a \\=\\= b'],
    ['a = b', 'a = b'],
    ['1 + 1 và ++x++', '1 + 1 và \\+\\+x\\+\\+'],
    ['~~gạch~~ ~ok', '\\~\\~gạch\\~\\~ ~ok'],
    ['# không phải tiêu đề', '\\# không phải tiêu đề'],
    ['> không phải trích dẫn', '\\> không phải trích dẫn'],
    ['  nhiều\n dòng\t\tvăn bản ', 'nhiều dòng văn bản'],
    ['Xin chào các bạn, hôm nay họp về kế hoạch quý 4.', 'Xin chào các bạn, hôm nay họp về kế hoạch quý 4.'],
  ])('%j → %j', (input, out) => expect(escapeMd(input)).toBe(out));
});

describe('pickMimeType (negotiation order)', () => {
  const MR = (list) => ({ isTypeSupported: (t) => list.includes(t) });
  it('prefers webm/opus', () => expect(pickMimeType(MR(MIME_CANDIDATES))).toBe('audio/webm;codecs=opus'));
  it('falls back to ogg/opus', () => expect(pickMimeType(MR(['audio/ogg;codecs=opus', 'audio/mp4']))).toBe('audio/ogg;codecs=opus'));
  it('falls back to mp4 (Safari)', () => expect(pickMimeType(MR(['audio/mp4']))).toBe('audio/mp4'));
  it('returns "" (browser default) when none is supported', () => expect(pickMimeType(MR([]))).toBe(''));
  it('returns "" without isTypeSupported and survives a throwing probe', () => {
    expect(pickMimeType({})).toBe('');
    expect(pickMimeType(null)).toBe('');
    let n = 0;
    expect(pickMimeType({ isTypeSupported: (t) => { if (n++ === 0) throw new Error('x'); return t === 'audio/mp4'; } })).toBe('audio/mp4');
  });
});

describe('buildRecordingMarkdown (byte-exact contract)', () => {
  const startedAt = new Date('2026-10-09T07:05:00Z');

  it('full block with transcript and bookmark', () => {
    const md = buildRecordingMarkdown({
      startedAt, durationSec: 754, url: 'nm-media:u1/n1/abc.webm',
      entries: [
        { t: 80, kind: 'mark', text: 'Chốt ngân sách' },
        { t: 5, kind: 'speech', text: 'Bắt đầu cuộc họp' },
      ],
    });
    expect(md).toBe(
      '## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)\n'
      + '[Ghi âm 12:34](nm-media:u1/n1/abc.webm)\n'
      + '\n'
      + '**Bản chép lời**\n'
      + '- **[00:05]** Bắt đầu cuộc họp\n'
      + '- **[01:20]** ⭐ Đánh dấu: Chốt ngân sách',
    );
  });

  it('no transcript section when there is nothing to list', () => {
    expect(buildRecordingMarkdown({ startedAt, durationSec: 42, url: 'nm-media:a/b/c.ogg', entries: [] })).toBe(
      '## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (00:42)\n[Ghi âm 00:42](nm-media:a/b/c.ogg)',
    );
    expect(buildRecordingMarkdown({ startedAt, durationSec: 42, url: 'nm-media:a/b/c.ogg', entries: [{ t: 1, kind: 'speech', text: '   ' }] }))
      .not.toContain('Bản chép lời');
  });

  it('bookmark without a note, and h:mm:ss durations', () => {
    expect(buildRecordingMarkdown({ startedAt, durationSec: 3600, url: 'nm-media:x.webm', entries: [{ t: 3599, kind: 'mark', text: '' }] })).toBe(
      '## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (1:00:00)\n[Ghi âm 1:00:00](nm-media:x.webm)\n\n**Bản chép lời**\n- **[59:59]** ⭐ Đánh dấu',
    );
  });

  it('transcript-only variant has no audio line', () => {
    expect(buildRecordingMarkdown({ startedAt, durationSec: 10, url: null, entries: [{ t: 2, kind: 'speech', text: 'chào' }] })).toBe(
      '## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (00:10)\n\n**Bản chép lời**\n- **[00:02]** chào',
    );
  });

  it('escapes transcript and bookmark text', () => {
    const md = buildRecordingMarkdown({ startedAt, durationSec: 10, url: 'nm-media:x.webm', entries: [
      { t: 1, kind: 'speech', text: 'giá *giảm* [50%]' },
      { t: 2, kind: 'mark', text: 'xem `file_a`' },
    ] });
    expect(md.split('\n').slice(-2)).toEqual(['- **[00:01]** giá \\*giảm\\* \\[50%\\]', '- **[00:02]** ⭐ Đánh dấu: xem \\`file\\_a\\`']);
  });

  it('sortEntries is stable for equal stamps', () => {
    const a = { t: 3, n: 'a' }, b = { t: 1, n: 'b' }, c = { t: 3, n: 'c' };
    expect(sortEntries([a, b, c]).map((x) => x.n)).toEqual(['b', 'a', 'c']);
  });
});

describe('micErrorMessage', () => {
  it.each([
    ['NotAllowedError', 'cho phép'],
    ['SecurityError', 'cho phép'],
    ['NotFoundError', 'Không tìm thấy micro'],
    ['OverconstrainedError', 'Không tìm thấy micro'],
    ['NotReadableError', 'ứng dụng khác'],
    ['insecure', 'HTTPS'],
    ['unsupported', 'không hỗ trợ ghi âm'],
  ])('%s → mentions "%s"', (name, frag) => {
    expect(micErrorMessage({ name })).toContain(frag);
  });
  it('unknown errors keep their message', () => {
    expect(micErrorMessage(new Error('boom'))).toContain('boom');
  });
});

describe('levelFromAnalyser', () => {
  it('silence → 0, full scale → 1, −30 dBFS → 0.5', () => {
    const buf = new Float32Array(8);
    expect(levelFromAnalyser({ getFloatTimeDomainData: (b) => b.fill(0) }, buf)).toBe(0);
    expect(levelFromAnalyser({ getFloatTimeDomainData: (b) => b.fill(1) }, buf)).toBe(1);
    expect(levelFromAnalyser({ getFloatTimeDomainData: (b) => b.fill(10 ** (-30 / 20)) }, buf)).toBeCloseTo(0.5, 5);
  });
  it('falls back to byte data', () => {
    const v = levelFromAnalyser({ getByteTimeDomainData: (b) => b.fill(255) }, new Float32Array(4));
    expect(v).toBeGreaterThan(0.95);
  });
});

describe('fixWebmDuration', () => {
  const head = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01];
  const segUnknown = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const info = [0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xa3, 0x83, 1, 2, 3];
  const webm = (...parts) => new Blob([new Uint8Array(parts.flat())], { type: 'audio/webm' });

  it('inserts Duration (ms at the default timecode scale) into Info', async () => {
    const out = new Uint8Array(await (await fixWebmDuration(webm(head, segUnknown, info, cluster), 3339)).arrayBuffer());
    expect(out.length).toBe(head.length + segUnknown.length + info.length + cluster.length + 11);
    const infoAt = head.length + segUnknown.length;
    expect(out[infoAt + 4]).toBe(0x80 | (7 + 11)); // Info size grew by the Duration element
    const d = infoAt + 5 + 7;
    expect([out[d], out[d + 1], out[d + 2]]).toEqual([0x44, 0x89, 0x88]);
    expect(new DataView(out.buffer, d + 3, 8).getFloat64(0)).toBe(3339);
    expect([...out.slice(-cluster.length)]).toEqual(cluster); // media data untouched
  });

  it('also grows a known Segment size', async () => {
    const segKnown = [0x18, 0x53, 0x80, 0x67, 0x80 | (info.length + cluster.length)];
    const out = new Uint8Array(await (await fixWebmDuration(webm(head, segKnown, info, cluster), 1000)).arrayBuffer());
    expect(out[head.length + 4]).toBe(0x80 | (info.length + cluster.length + 11));
  });

  it('leaves non-WebM, SeekHead layouts and existing durations alone', async () => {
    const plain = new Blob(['abc'], { type: 'audio/webm' });
    expect(await fixWebmDuration(plain, 1000)).toBe(plain);
    const mp4 = new Blob([new Uint8Array([...head, ...segUnknown, ...info])], { type: 'audio/mp4' });
    expect(await fixWebmDuration(mp4, 1000)).toBe(mp4);
    const seek = webm(head, segUnknown, [0x11, 0x4d, 0x9b, 0x74, 0x80], info, cluster);
    expect(await fixWebmDuration(seek, 1000)).toBe(seek);
    const once = await fixWebmDuration(webm(head, segUnknown, info, cluster), 1000);
    expect(await fixWebmDuration(once, 2000)).toBe(once);
    const zero = webm(head, segUnknown, info, cluster);
    expect(await fixWebmDuration(zero, 0)).toBe(zero);
  });
});

describe('TRANSITIONS', () => {
  it('describes the recorder lifecycle', () => {
    expect(TRANSITIONS.idle).toEqual(['requesting']);
    expect(TRANSITIONS.recording).toEqual(expect.arrayContaining(['paused', 'stopped']));
    expect(TRANSITIONS.paused).toEqual(expect.arrayContaining(['recording', 'stopped']));
    expect(TRANSITIONS.saving).toEqual(expect.arrayContaining(['done', 'error']));
    expect(TRANSITIONS.done).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Transcriber                                                         */
/* ------------------------------------------------------------------ */

describe('createTranscriber', () => {
  function make(extra = {}) {
    let now = 0;
    const out = { finals: [], interims: [], errors: [], setTime: (t) => { now = t; } };
    const t = createTranscriber({
      Recognition: globalThis.webkitSpeechRecognition,
      getTime: () => now,
      onFinal: (s) => out.finals.push(s),
      onInterim: (s) => out.interims.push(s),
      onError: (k, m) => out.errors.push([k, m]),
      ...extra,
    });
    return { t, out };
  }

  it('configures vi-VN, continuous, interim results', () => {
    const { t } = make();
    t.start();
    const r = lastSR();
    expect(r.lang).toBe('vi-VN');
    expect(r.continuous).toBe(true);
    expect(r.interimResults).toBe(true);
    expect(r.started).toBe(true);
  });

  it('stamps a final segment with the time it was first heard', () => {
    const { t, out } = make();
    t.start();
    out.setTime(4.6);
    lastSR().say('xin');
    out.setTime(7);
    lastSR().say('xin chào', true);
    expect(out.finals).toEqual([{ t: 4.6, text: 'xin chào' }]);
    expect(out.interims).toEqual(['xin', '']);
  });

  it('auto-restarts on end while wanted, not after stop()', async () => {
    const { t } = make();
    t.start();
    lastSR().end();
    await advance(300);
    expect(env.recognitions).toHaveLength(2);
    expect(lastSR().started).toBe(true);
    t.stop();
    await flush();
    await advance(2000);
    expect(env.recognitions).toHaveLength(2);
  });

  it('fatal errors stop it; benign ones do not', async () => {
    const { t, out } = make();
    t.start();
    lastSR().onerror({ error: 'no-speech' });
    expect(out.errors).toEqual([]);
    lastSR().onerror({ error: 'not-allowed' });
    lastSR().end();
    await advance(1000);
    expect(env.recognitions).toHaveLength(1);
    expect(out.errors[0][0]).toBe('fatal');
    expect(t.active).toBe(false);
  });

  it('gives up after repeated rapid restarts', async () => {
    const { t, out } = make();
    t.start();
    for (let i = 0; i < 12; i++) { lastSR().end(); await advance(260); }
    expect(out.errors.some(([k]) => k === 'unstable')).toBe(true);
    expect(env.recognitions.length).toBeLessThanOrEqual(9);
  });
});

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

describe('support probes', () => {
  it('isRecordingSupported / isTranscriptionSupported', () => {
    expect(isRecordingSupported()).toBe(true);
    expect(isTranscriptionSupported()).toBe(true);
    delete globalThis.webkitSpeechRecognition;
    expect(isTranscriptionSupported()).toBe(false);
    defineNav('mediaDevices', undefined);
    expect(isRecordingSupported()).toBe(false);
  });
});

describe('openRecorder — dialog', () => {
  it('opens an accessible modal in idle with transcription off by default', async () => {
    const { r } = open();
    await flush();
    const dlg = q('dialog.rec');
    expect(dlg.open).toBe(true);
    expect(state()).toBe('idle');
    expect(dlg.getAttribute('aria-labelledby')).toBe('rec-title');
    expect(q('#rec-title').textContent).toBe('Ghi âm cuộc họp');
    expect(document.activeElement).toBe(btn('start'));
    expect(q('[data-role="transcribe"]').checked).toBe(false);
    expect(q('.rec__note').textContent).toContain('dịch vụ nhận dạng giọng nói của trình duyệt');
    expect(timer()).toBe('00:00');
    expect(r.state).toBe('idle');
  });

  it('idle → requesting → recording, with the negotiated recorder settings', async () => {
    env.gumDeferred = Promise.withResolvers ? Promise.withResolvers() : (() => { let res; const p = new Promise((r) => { res = r; }); return { promise: p, resolve: res }; })();
    open();
    btn('start').click();
    await flush();
    expect(state()).toBe('requesting');
    expect(btn('start').disabled).toBe(true);
    env.gumDeferred.resolve();
    await flush();
    expect(state()).toBe('recording');
    const c = env.gum.mock.calls[0][0];
    expect(c.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true });
    expect(lastRec().opts).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
    expect(lastRec().timeslice).toBe(1000);
    expect(btn('pause').hidden).toBe(false);
    expect(btn('stop').hidden).toBe(false);
    expect(btn('mark').hidden).toBe(false);
    expect(btn('start').hidden).toBe(true);
  });

  it('retries the MediaRecorder without a mimeType when the preferred one is refused', async () => {
    env.mrThrowOnMime = true;
    await startRecording();
    expect(state()).toBe('recording');
    expect(lastRec().opts).toEqual({ audioBitsPerSecond: 32000 });
  });

  it('uses ogg/opus when webm is unsupported', async () => {
    env.supported = ['audio/ogg;codecs=opus'];
    await startRecording();
    expect(lastRec().opts.mimeType).toBe('audio/ogg;codecs=opus');
  });

  it('elapsed timer excludes paused time', async () => {
    await startRecording();
    await advance(65_000);
    expect(timer()).toBe('01:05');
    await click('pause');
    expect(state()).toBe('paused');
    expect(lastRec().state).toBe('paused');
    await advance(30_000);
    expect(timer()).toBe('01:05');
    await click('resume');
    expect(state()).toBe('recording');
    expect(lastRec().state).toBe('recording');
    await advance(10_000);
    expect(timer()).toBe('01:15');
  });

  it('warns at 55 min and auto-stops at 60 min', async () => {
    await startRecording();
    await advance(55 * 60_000 + 400);
    expect(q('[data-role="msg"]').hidden).toBe(false);
    expect(q('[data-role="msg"]').textContent).toContain('Còn 5 phút');
    expect(state()).toBe('recording');
    await advance(5 * 60_000);
    expect(state()).toBe('stopped');
    expect(q('[data-role="msg"]').textContent).toContain('giới hạn 60 phút');
    expect(timer()).toBe('1:00:00');
  });

  it('assembles timeslice chunks into one blob of the base mime type', async () => {
    const { uploadAudio } = await startRecording();
    lastRec().emit('aaa');
    lastRec().ondataavailable({ data: new Blob([]) }); // empty chunk ignored
    lastRec().emit('bbbb');
    await advance(3000);
    await click('stop');
    await flush();
    expect(state()).toBe('stopped');
    await click('save');
    await flush();
    const blob = uploadAudio.mock.calls[0][1];
    expect(blob.type).toBe('audio/webm');
    expect(blob.size).toBe(3 + 4 + 4); // + 'tail' flushed by stop()
    expect(await blob.text()).toBe('aaabbbbtail');
  });

  it('stop releases the mic, meter and wake lock and shows the preview', async () => {
    await startRecording();
    await flush();
    expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
    await advance(2000);
    await click('stop');
    await flush();
    expect(env.tracks[0].stop).toHaveBeenCalled();
    expect(env.contexts[0].close).toHaveBeenCalled();
    expect(env.locks[0].release).toHaveBeenCalled();
    expect(q('[data-role="preview"]').hidden).toBe(false);
    expect(q('[data-role="preview"]').getAttribute('src')).toBe('blob:mock');
    expect(btn('save').hidden).toBe(false);
    expect(btn('save').disabled).toBe(false);
    expect(btn('download').hidden).toBe(false);
  });

  it('pause releases the wake lock and resume re-acquires it', async () => {
    await startRecording();
    await flush();
    await click('pause');
    expect(env.locks[0].release).toHaveBeenCalled();
    await click('resume');
    await flush();
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it('save uploads with metadata, inserts the exact markdown and closes', async () => {
    const { calls, uploadAudio } = await startRecording();
    await advance(754_000);
    lastRec().emit('x');
    await click('stop');
    await flush();
    await click('save');
    await flush();
    expect(uploadAudio).toHaveBeenCalledWith('n1', expect.any(Blob), { mimeType: 'audio/webm', durationSec: 754 });
    expect(calls.inserted).toEqual(['## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)\n[Ghi âm 12:34](nm-media:u1/n1/abc.webm)']);
    expect(q('dialog.rec')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('upload failure → error state, blob kept, retry succeeds with the same blob', async () => {
    let n = 0;
    const uploadAudio = vi.fn(async () => { if (n++ === 0) throw new Error('Mất kết nối mạng'); return { url: 'nm-media:u/n/r.webm' }; });
    const { calls } = await startRecording({ uploadAudio });
    await advance(5000);
    await click('stop');
    await click('save');
    await flush();
    expect(state()).toBe('error');
    expect(q('[data-role="msg"]').textContent).toContain('Mất kết nối mạng');
    expect(btn('retry-save').hidden).toBe(false);
    expect(btn('download').hidden).toBe(false);
    expect(calls.errors).toHaveLength(1);
    expect(calls.inserted).toEqual([]);
    await click('retry-save');
    await flush();
    expect(uploadAudio).toHaveBeenCalledTimes(2);
    expect(uploadAudio.mock.calls[1][1]).toBe(uploadAudio.mock.calls[0][1]);
    expect(calls.inserted[0]).toContain('[Ghi âm 00:05](nm-media:u/n/r.webm)');
    expect(q('dialog.rec')).toBeNull();
  });

  it('shows busy state while uploading', async () => {
    let release;
    const uploadAudio = vi.fn(() => new Promise((r) => { release = r; }));
    await startRecording({ uploadAudio });
    await advance(2000);
    await click('stop');
    await click('save');
    expect(state()).toBe('saving');
    expect(btn('save').disabled).toBe(true);
    expect(btn('save').getAttribute('aria-busy')).toBe('true');
    expect(q('[data-role="status"]').textContent).toContain('Đang tải bản ghi lên');
    release({ url: 'nm-media:z.webm' });
    await flush();
    expect(q('dialog.rec')).toBeNull();
  });

  it('when onInsert throws after upload, retry does not upload again', async () => {
    let fail = true;
    const onInsert = vi.fn(() => { if (fail) { fail = false; throw new Error('editor busy'); } });
    const { uploadAudio } = await startRecording({ onInsert });
    await advance(2000);
    await click('stop');
    await click('save');
    await flush();
    expect(state()).toBe('error');
    expect(btn('transcript-only').hidden).toBe(true);
    await click('retry-save');
    await flush();
    expect(uploadAudio).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledTimes(2);
  });

  it('"Chỉ chèn bản chép lời" after a failed upload inserts heading + transcript only', async () => {
    const uploadAudio = vi.fn(async () => { throw new Error('storage_unavailable'); });
    const { calls } = await startRecording({ uploadAudio });
    await advance(3000);
    await click('mark');
    await click('stop');
    expect(btn('transcript-only').hidden).toBe(true); // only offered when upload is impossible
    await click('save');
    await flush();
    expect(btn('transcript-only').hidden).toBe(false);
    await click('transcript-only');
    expect(calls.inserted).toEqual(['## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (00:03)\n\n**Bản chép lời**\n- **[00:03]** ⭐ Đánh dấu']);
    expect(q('dialog.rec')).toBeNull();
  });

  it('an empty recording cannot be saved', async () => {
    await startRecording();
    lastRec().stop = function stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); };
    await click('stop');
    await flush();
    expect(state()).toBe('stopped');
    expect(btn('save').disabled).toBe(true);
    expect(q('[data-role="msg"]').textContent).toContain('Bản ghi trống');
  });

  it('bookmarks capture the current time and an optional note', async () => {
    const { calls } = await startRecording();
    await advance(80_000);
    await click('mark');
    const input = q('.rec__line--mark input');
    expect(q('.rec__line--mark .rec__ts').textContent).toBe('[01:20]');
    expect(document.activeElement).toBe(input);
    input.value = 'Chốt *ngân sách*';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await advance(10_000);
    await click('stop');
    await click('save');
    await flush();
    expect(calls.inserted[0].split('\n').slice(2)).toEqual(['', '**Bản chép lời**', '- **[01:20]** ⭐ Đánh dấu: Chốt \\*ngân sách\\*']);
  });

  it('mic and transcription controls are locked appropriately while recording', async () => {
    await startRecording();
    expect(q('[data-role="mic"]').disabled).toBe(true);
    expect(q('[data-role="transcribe"]').disabled).toBe(false);
  });

  it('lists microphones after permission and passes the chosen device', async () => {
    open();
    await flush();
    const mic = q('[data-role="mic"]');
    const labels = [...mic.options].map((o) => o.textContent);
    expect(labels).toEqual(['Micro mặc định', 'Micro USB', 'Micro 2']);
    mic.value = 'mic-2';
    mic.dispatchEvent(new Event('change'));
    await click('start');
    await flush();
    expect(env.gum.mock.calls[0][0].audio.deviceId).toEqual({ ideal: 'mic-2' });
    expect(localStorage.getItem('nm.recorder.mic')).toBe('mic-2');
  });

  it('level meter reflects the analyser RMS', async () => {
    env.level = 10 ** (-30 / 20);
    await startRecording();
    await advance(400);
    expect(Number(q('[data-role="meter"]').dataset.level)).toBeCloseTo(0.5, 2);
  });

  it('a silent mic shows a hint after a few seconds', async () => {
    env.level = 0;
    await startRecording();
    await advance(7000);
    expect(q('[data-role="hint"]').hidden).toBe(false);
    expect(q('[data-role="hint"]').textContent).toContain('Không thu được âm thanh');
  });

  it('an unplugged mic stops the recording and keeps what was recorded', async () => {
    await startRecording();
    lastRec().emit('abc');
    await advance(2000);
    env.tracks[0].fire('ended');
    await flush();
    expect(state()).toBe('stopped');
    expect(q('[data-role="msg"]').textContent).toContain('Micro đã bị ngắt');
    expect(btn('save').disabled).toBe(false);
  });
});

describe('openRecorder — transcription', () => {
  it('toggle starts vi-VN recognition; finals listed with recording time excluding pauses; interim greyed', async () => {
    const { calls } = await startRecording();
    const toggle = q('[data-role="transcribe"]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(env.recognitions).toHaveLength(1);
    expect(lastSR().lang).toBe('vi-VN');

    await advance(5000);
    lastSR().say('xin chào');
    expect(q('[data-role="interim"]').textContent).toBe('xin chào');
    lastSR().say('xin chào mọi người', true);
    expect(q('[data-role="interim"]').textContent).toBe('');
    expect(q('.rec__line input').value).toBe('xin chào mọi người');
    expect(q('.rec__line .rec__ts').textContent).toBe('[00:05]');

    await click('pause');
    await flush();
    const before = env.recognitions.length;
    await advance(60_000); // paused minute is excluded and recognition is not restarted
    expect(env.recognitions.length).toBe(before);
    await click('resume');
    expect(env.recognitions.length).toBe(before + 1);
    await advance(10_000);
    lastSR().say('phần tiếp theo', true);
    const stamps = [...document.querySelectorAll('.rec__line .rec__ts')].map((n) => n.textContent);
    expect(stamps).toEqual(['[00:05]', '[00:15]']);

    await click('stop');
    await click('save');
    await flush();
    expect(calls.inserted[0]).toBe(
      '## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (00:15)\n[Ghi âm 00:15](nm-media:u1/n1/abc.webm)\n\n**Bản chép lời**\n'
      + '- **[00:05]** xin chào mọi người\n- **[00:15]** phần tiếp theo',
    );
  });

  it('auto-restarts recognition when the service ends while recording', async () => {
    const toggle = () => { const t = q('[data-role="transcribe"]'); t.checked = true; t.dispatchEvent(new Event('change')); };
    open();
    toggle(); // chosen before recording: starts with the recording
    expect(env.recognitions).toHaveLength(0);
    await click('start');
    await flush();
    expect(env.recognitions).toHaveLength(1);
    lastSR().end();
    await advance(300);
    expect(env.recognitions).toHaveLength(2);
    expect(lastSR().started).toBe(true);
  });

  it('user edits and deletions of transcript lines are what gets saved', async () => {
    const { calls } = await startRecording();
    const t = q('[data-role="transcribe"]'); t.checked = true; t.dispatchEvent(new Event('change'));
    await advance(1000);
    lastSR().say('dòng một', true);
    await advance(1000);
    lastSR().say('dòng hai sai', true);
    await advance(1000);
    lastSR().say('dòng ba', true);
    const inputs = document.querySelectorAll('.rec__line input');
    inputs[1].value = 'dòng hai đã sửa';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelectorAll('.rec__line [data-act="del-line"]')[2].click();
    await click('stop');
    await click('save');
    await flush();
    expect(calls.inserted[0].split('\n').slice(3)).toEqual(['**Bản chép lời**', '- **[00:01]** dòng một', '- **[00:02]** dòng hai đã sửa']);
  });

  it('transcription is unavailable without SpeechRecognition', async () => {
    delete globalThis.webkitSpeechRecognition;
    open();
    expect(q('[data-role="transcribe"]').disabled).toBe(true);
    expect(q('.rec__note').textContent).toContain('không hỗ trợ chép lời');
  });

  it('a fatal recognition error turns the toggle off but keeps recording', async () => {
    await startRecording();
    const t = q('[data-role="transcribe"]'); t.checked = true; t.dispatchEvent(new Event('change'));
    lastSR().onerror({ error: 'service-not-allowed' });
    lastSR().end();
    await advance(1000);
    expect(t.checked).toBe(false);
    expect(state()).toBe('recording');
    expect(env.recognitions).toHaveLength(1);
    expect(q('[data-role="hint"]').textContent).toContain('chép lời');
  });
});

describe('openRecorder — mic errors', () => {
  it.each([
    ['NotAllowedError', 'cho phép'],
    ['NotFoundError', 'Không tìm thấy micro'],
    ['NotReadableError', 'ứng dụng khác'],
  ])('%s → error state with a Vietnamese message', async (name, frag) => {
    env.gumError = new DOMException('x', name);
    const { calls } = await startRecording();
    expect(state()).toBe('error');
    expect(q('[data-role="msg"]').textContent).toContain(frag);
    expect(btn('retry-mic').hidden).toBe(false);
    expect(calls.errors).toHaveLength(1);
  });

  it('insecure context is explained before asking for the mic', async () => {
    globalThis.isSecureContext = false;
    try {
      await startRecording();
      expect(state()).toBe('error');
      expect(q('[data-role="msg"]').textContent).toContain('HTTPS');
      expect(env.gum).not.toHaveBeenCalled();
    } finally {
      delete globalThis.isSecureContext;
    }
  });

  it('retry after granting permission records normally', async () => {
    env.gumError = new DOMException('x', 'NotAllowedError');
    await startRecording();
    env.gumError = null;
    await click('retry-mic');
    await flush();
    expect(state()).toBe('recording');
    expect(q('[data-role="msg"]').hidden).toBe(true);
  });
});

describe('openRecorder — closing and cleanup', () => {
  const esc = () => q('dialog.rec').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  it('Esc in idle closes without asking', async () => {
    const confirmDiscard = vi.fn(async () => true);
    open({ confirmDiscard });
    esc();
    await flush();
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(q('dialog.rec')).toBeNull();
  });

  it('Esc while recording asks; "no" keeps recording', async () => {
    const confirmDiscard = vi.fn(async () => false);
    await startRecording({ confirmDiscard });
    esc();
    await flush();
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(state()).toBe('recording');
    expect(env.tracks[0].stop).not.toHaveBeenCalled();
  });

  it('confirmed discard stops recorder, tracks, recognition and wake lock', async () => {
    const confirmDiscard = vi.fn(async () => true);
    const { calls } = await startRecording({ confirmDiscard });
    const t = q('[data-role="transcribe"]'); t.checked = true; t.dispatchEvent(new Event('change'));
    await flush();
    btn('discard').click();
    await flush();
    expect(q('dialog.rec')).toBeNull();
    expect(lastRec().state).toBe('inactive');
    expect(env.tracks[0].stop).toHaveBeenCalled();
    expect(lastSR().aborted).toBe(true);
    expect(env.contexts[0].close).toHaveBeenCalled();
    expect(env.locks[0].release).toHaveBeenCalled();
    expect(calls.inserted).toEqual([]);
  });

  it('a stopped, unsaved recording also asks before discarding', async () => {
    const confirmDiscard = vi.fn(async () => true);
    await startRecording({ confirmDiscard });
    await advance(1000);
    await click('stop');
    await click('close');
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(q('dialog.rec')).toBeNull();
  });

  it('uses the shared confirm dialog by default', async () => {
    await startRecording();
    btn('close').click();
    await flush();
    const dialogs = document.querySelectorAll('dialog');
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1].textContent).toContain('Bỏ bản ghi này?');
    dialogs[1].querySelector('[data-close]').click(); // "Quay lại"
    await flush();
    expect(state()).toBe('recording');
  });

  it('close() from the API releases everything', async () => {
    const { r } = await startRecording();
    r.close();
    await flush();
    expect(q('dialog.rec')).toBeNull();
    expect(env.tracks[0].stop).toHaveBeenCalled();
    expect(lastRec().state).toBe('inactive');
  });

  it('a permission prompt answered after close stops the new tracks', async () => {
    env.gumDeferred = (() => { let res; const p = new Promise((r) => { res = r; }); return { promise: p, resolve: res }; })();
    const { r } = open();
    btn('start').click();
    await flush();
    r.close();
    env.gumDeferred.resolve();
    await flush();
    expect(env.tracks[0].stop).toHaveBeenCalled();
    expect(env.recorders).toHaveLength(0);
  });

  it('beforeunload is guarded only while there is unsaved audio', async () => {
    open();
    const ev1 = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev1);
    expect(ev1.defaultPrevented).toBe(false);
    await click('start');
    await flush();
    const ev2 = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(true);
  });

  it('Tab is trapped inside the dialog', async () => {
    open();
    await flush();
    const dlg = q('dialog.rec');
    const visible = [...dlg.querySelectorAll('button, select, input')].filter((n) => !n.disabled && !n.closest('[hidden]'));
    visible[visible.length - 1].focus();
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(visible[0]);
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(visible[visible.length - 1]);
  });
});
