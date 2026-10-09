// Meeting recorder (stream A6) — see docs/rich-editor-design.md, "recorder.js".
//
//   isRecordingSupported() -> boolean
//   isTranscriptionSupported() -> boolean
//   openRecorder({ noteId, uploadAudio, onInsert(markdown), onError }) -> { close() }
//
// The dialog records the microphone with MediaRecorder (Opus, 32 kbps, 1 s
// timeslice chunks), shows an elapsed timer and a live level meter, optionally
// transcribes Vietnamese speech live with the browser's SpeechRecognition, lets
// the user drop bookmarks ("Đánh dấu"), and on "Lưu vào ghi chú" uploads the
// audio through `uploadAudio(noteId, blob, { mimeType, durationSec })` and hands
// the canonical Markdown block to `onInsert`.
//
// State machine (dialog[data-state]):
//   idle → requesting → recording ⇄ paused → stopped → saving → done
//   requesting → error (mic)   → requesting (retry)
//   saving     → error (upload)→ saving (retry) | done (transcript only)
//
// Decisions (documented for the coordinator):
// - "Chỉ chèn bản chép lời" is offered only after an upload failed (or the blob
//   is over the 25 MB bucket limit) AND there is at least one transcript line or
//   bookmark; it inserts the heading + transcript without the audio link. The
//   blob stays in memory and "Tải tệp ghi âm" lets the user save it locally, so
//   an upload failure never loses the meeting.
// - Bookmarks are listed in the "**Bản chép lời**" section even when live
//   transcription was off (otherwise they would be lost); the section is
//   omitted only when there is neither transcript text nor a bookmark.
// - Chunks are kept in memory (timeslice 1 s), so a MediaRecorder error or an
//   unplugged mic keeps everything recorded so far. A full tab crash is not
//   recovered (no IndexedDB journal).
// - The mic can be chosen before recording (the list shows device names once
//   the site has mic permission); it is locked while recording because
//   MediaRecorder cannot switch tracks. SpeechRecognition always listens to the
//   browser's default mic.
// - `onError(err)` is informational (logging): the dialog already shows every
//   error inline, so the page should not toast it again.

import { html, raw, fragment } from '../../utils/dom.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../modal.js';
import { dayOf, getTimezone } from '../../utils/date.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const MAX_SEC = 60 * 60;          // hard limit: auto-stop
export const WARN_SEC = 55 * 60;         // warning
export const TIMESLICE_MS = 1000;        // MediaRecorder chunk size
export const AUDIO_BITS = 32000;         // 32 kbps Opus ≈ 14 MB / hour
export const AUDIO_MAX = 25 * 1024 * 1024; // bucket limit (mirrors noteMedia.AUDIO_MAX)
export const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const TICK_MS = 200;
const SILENCE_HINT_MS = 6000;
const MIC_PREF_KEY = 'nm.recorder.mic';

/** Allowed transitions; anything else is ignored (defensive against racing events). */
export const TRANSITIONS = {
  idle: ['requesting'],
  requesting: ['recording', 'error', 'idle'],
  recording: ['paused', 'stopped'],
  paused: ['recording', 'stopped'],
  stopped: ['saving', 'done'],
  saving: ['done', 'error'],
  error: ['requesting', 'saving', 'done'],
  done: [],
};

/* ------------------------------------------------------------------ */
/* Environment probes                                                  */
/* ------------------------------------------------------------------ */

const G = globalThis;
const SR = () => G.SpeechRecognition || G.webkitSpeechRecognition || null;
const AC = () => G.AudioContext || G.webkitAudioContext || null;

export function isRecordingSupported() {
  return !!(G.navigator?.mediaDevices?.getUserMedia && typeof G.MediaRecorder === 'function');
}

export function isTranscriptionSupported() {
  return typeof SR() === 'function';
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/** First supported container from MIME_CANDIDATES; '' = let the browser choose. */
export function pickMimeType(MR = G.MediaRecorder) {
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  for (const c of MIME_CANDIDATES) {
    try { if (MR.isTypeSupported(c)) return c; } catch { /* keep looking */ }
  }
  return '';
}

/** 'audio/webm;codecs=opus' → 'audio/webm' */
export const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();

const pad = (n) => String(n).padStart(2, '0');

/** Elapsed seconds → 'mm:ss', or 'h:mm:ss' from one hour on. */
export function fmtElapsed(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/** Transcript stamp: always 'mm:ss' (minutes may exceed 59 → '60:00'). */
export function fmtStamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/**
 * Make free text (speech, bookmark notes) literal Markdown in our dialect:
 * whitespace collapsed to one line; `\ * _ ` [ ] |` always escaped; `~ = +`
 * escaped when doubled (`~~`, `==`, `++` are marks); a leading `#`/`>` escaped.
 */
export function escapeMd(text) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[\\*_`[\]|]/g, '\\$&');
  s = s.replace(/([~=+])\1+/g, (run) => run.replace(/./g, '\\$&'));
  s = s.replace(/^[#>]/, '\\$&');
  return s;
}

/** 'HH:MM' and 'dd/MM/yyyy' of an instant in the user's timezone. */
export function meetingWhen(startedAt) {
  const d = startedAt instanceof Date ? startedAt : new Date(startedAt);
  let hm;
  try {
    hm = new Intl.DateTimeFormat('en-GB', { timeZone: getTimezone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  } catch {
    hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const [y, mo, da] = dayOf(d).split('-');
  return { time: hm, date: `${da}/${mo}/${y}` };
}

/**
 * The block inserted into the note (contract in docs/rich-editor-design.md):
 *
 *   ## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)
 *   [Ghi âm 12:34](nm-media:<path>.webm)
 *
 *   **Bản chép lời**
 *   - **[00:05]** …
 *   - **[01:20]** ⭐ Đánh dấu: …
 *
 * `url` null → transcript-only variant (no audio line). Entries:
 * { t: seconds, kind: 'speech'|'mark', text }. Empty speech lines are dropped;
 * the section is omitted when nothing remains. No trailing newline.
 */
export function buildRecordingMarkdown({ startedAt, durationSec, url = null, entries = [] }) {
  const { time, date } = meetingWhen(startedAt);
  const dur = fmtElapsed(durationSec);
  const lines = [`## 🎙 Ghi âm cuộc họp — ${time}, ${date} (${dur})`];
  if (url) lines.push(`[Ghi âm ${dur}](${String(url).replace(/[ ()]/g, encodeURIComponent)})`);
  const items = sortEntries(entries)
    .map((e) => {
      const txt = escapeMd(e.text);
      if (e.kind === 'mark') return `- **[${fmtStamp(e.t)}]** ⭐ Đánh dấu${txt ? ': ' + txt : ''}`;
      return txt ? `- **[${fmtStamp(e.t)}]** ${txt}` : null;
    })
    .filter(Boolean);
  if (items.length) lines.push('', '**Bản chép lời**', ...items);
  return lines.join('\n');
}

/** Stable sort by time (insertion order kept for equal stamps). */
export function sortEntries(entries) {
  return entries.map((e, i) => [e, i]).sort((a, b) => (a[0].t - b[0].t) || (a[1] - b[1])).map(([e]) => e);
}

/** getUserMedia / context failures → Vietnamese message. */
export function micErrorMessage(err) {
  const name = err?.name || err?.code || '';
  switch (name) {
    case 'insecure':
      return 'Trình duyệt chỉ cho phép ghi âm trên kết nối an toàn (HTTPS hoặc localhost). Hãy mở ứng dụng qua địa chỉ https://.';
    case 'unsupported':
      return 'Trình duyệt này không hỗ trợ ghi âm. Hãy dùng Chrome, Edge, Firefox hoặc Safari phiên bản mới.';
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Bạn chưa cho phép dùng micro. Hãy bấm biểu tượng ổ khóa cạnh thanh địa chỉ, cho phép Micro cho trang này rồi bấm "Thử lại".';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'Không tìm thấy micro. Hãy cắm micro hoặc tai nghe có micro, rồi bấm "Thử lại".';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Không mở được micro — có thể ứng dụng khác (Zoom, Teams, Meet…) đang dùng nó. Hãy đóng ứng dụng đó rồi bấm "Thử lại".';
    case 'recorder':
      return 'Trình duyệt không khởi động được bộ ghi âm. Hãy tải lại trang rồi thử lại.';
    default:
      return `Không mở được micro${err?.message ? ` (${err.message})` : ''}. Hãy thử lại.`;
  }
}

/** RMS of an AnalyserNode's time-domain signal mapped to 0…1 (−60 dBFS … 0 dBFS). */
export function levelFromAnalyser(analyser, buf) {
  let sum = 0;
  if (typeof analyser.getFloatTimeDomainData === 'function') {
    analyser.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  } else {
    const b = new Uint8Array(buf.length);
    analyser.getByteTimeDomainData(b);
    for (let i = 0; i < b.length; i++) { const v = (b[i] - 128) / 128; sum += v * v; }
  }
  const rms = Math.sqrt(sum / (buf.length || 1));
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/* ---------- WebM duration patch ---------- */

const EBML_ID = 0x1a45dfa3, SEGMENT = 0x18538067, SEEKHEAD = 0x114d9b74, INFO = 0x1549a966,
  CLUSTER = 0x1f43b675, DURATION = 0x4489, TIMECODE_SCALE = 0x2ad7b1;

function readId(b, i) {
  const first = b[i];
  if (!first) return null;
  let len = 1, mask = 0x80;
  while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 4 || i + len > b.length) return null;
  let id = 0;
  for (let k = 0; k < len; k++) id = id * 256 + b[i + k];
  return { id, len };
}

function readVint(b, i) {
  const first = b[i];
  if (!first) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || i + len > b.length) return null;
  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let k = 1; k < len; k++) { value = value * 256 + b[i + k]; if (b[i + k] !== 0xff) unknown = false; }
  return { value, len, unknown };
}

function writeVint(value, len) {
  if (value >= 2 ** (7 * len) - 1) return null;
  const out = new Uint8Array(len);
  let v = value;
  for (let k = len - 1; k >= 0; k--) { out[k] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

/**
 * MediaRecorder WebM (Chrome/Edge/Firefox) is written as a live stream without
 * a Duration in Segment/Info, so <audio> reports Infinity and cannot seek.
 * Insert Duration (float64) into Info. Returns the original blob whenever the
 * layout is not the simple one MediaRecorder produces (SeekHead present,
 * Duration already there, header not in the first 64 KB, not WebM…).
 */
export async function fixWebmDuration(blob, durationMs) {
  try {
    if (!blob || !/webm/i.test(blob.type || '') || !(durationMs > 0)) return blob;
    const b = new Uint8Array(await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer());
    let id = readId(b, 0);
    if (!id || id.id !== EBML_ID) return blob;
    let sz = readVint(b, id.len);
    if (!sz) return blob;
    let i = id.len + sz.len + sz.value;
    id = readId(b, i);
    if (!id || id.id !== SEGMENT) return blob;
    const segSizePos = i + id.len;
    const seg = readVint(b, segSizePos);
    if (!seg) return blob;
    i = segSizePos + seg.len;
    let info = null;
    while (i < b.length) {
      id = readId(b, i);
      if (!id) return blob;
      sz = readVint(b, i + id.len);
      if (!sz) return blob;
      if (id.id === SEEKHEAD || id.id === CLUSTER) return blob;
      if (id.id === INFO) { info = { start: i, idLen: id.len, sizeLen: sz.len, size: sz.value }; break; }
      if (sz.unknown) return blob;
      i += id.len + sz.len + sz.value;
    }
    if (!info) return blob;
    const dataStart = info.start + info.idLen + info.sizeLen;
    const dataEnd = dataStart + info.size;
    if (dataEnd > b.length) return blob;
    let scale = 1e6;
    for (let j = dataStart; j < dataEnd;) {
      const cid = readId(b, j);
      const cs = cid && readVint(b, j + cid.len);
      if (!cs) return blob;
      const p = j + cid.len + cs.len;
      if (cid.id === DURATION) return blob;
      if (cid.id === TIMECODE_SCALE) { scale = 0; for (let k = 0; k < cs.value; k++) scale = scale * 256 + b[p + k]; }
      j = p + cs.value;
    }
    if (!(scale > 0)) return blob;
    const dur = new Uint8Array(11);
    dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
    new DataView(dur.buffer).setFloat64(3, (durationMs * 1e6) / scale);
    const infoSize = writeVint(info.size + dur.length, info.sizeLen);
    if (!infoSize) return blob;
    let segSize = b.subarray(segSizePos, segSizePos + seg.len);
    if (!seg.unknown) {
      segSize = writeVint(seg.value + dur.length, seg.len);
      if (!segSize) return blob;
    }
    return new Blob([
      b.subarray(0, segSizePos), segSize,
      b.subarray(segSizePos + seg.len, info.start + info.idLen), infoSize,
      b.subarray(dataStart, dataEnd), dur,
      blob.slice(dataEnd),
    ], { type: blob.type });
  } catch {
    return blob;
  }
}

/* ------------------------------------------------------------------ */
/* Live transcription                                                  */
/* ------------------------------------------------------------------ */

/**
 * Wraps SpeechRecognition: vi-VN, continuous, interim results, auto-restart
 * on 'end' while wanted. Each final segment is stamped with getTime() taken
 * when that result was first heard (recording time, pauses excluded).
 */
export function createTranscriber({ Recognition = SR(), lang = 'vi-VN', getTime, onFinal, onInterim, onError }) {
  let rec = null;
  let wanted = false;
  let restartTimer = 0;
  let recent = [];
  let starts = new Map();
  let done = new Set();

  const spawn = () => {
    restartTimer = 0;
    if (!wanted) return;
    const now = Date.now();
    recent = recent.filter((t) => now - t < 15000);
    recent.push(now);
    if (recent.length > 8) {
      wanted = false;
      onError?.('unstable', 'Dịch vụ chép lời liên tục bị ngắt nên đã tạm tắt. Bản ghi âm vẫn tiếp tục.');
      return;
    }
    starts = new Map();
    done = new Set();
    let r;
    try {
      r = new Recognition();
    } catch {
      wanted = false;
      onError?.('fatal', 'Không khởi động được dịch vụ chép lời.');
      return;
    }
    rec = r;
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      if (r !== rec) return;
      let interim = '';
      for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res?.[0]?.transcript || '';
        if (!starts.has(i)) starts.set(i, getTime());
        if (res.isFinal) {
          if (!done.has(i)) {
            done.add(i);
            const clean = txt.replace(/\s+/g, ' ').trim();
            if (clean) onFinal?.({ t: starts.get(i), text: clean });
          }
        } else interim += txt;
      }
      onInterim?.(interim.replace(/\s+/g, ' ').trim());
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      const code = e?.error || '';
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        wanted = false;
        onError?.('fatal', 'Trình duyệt không cho phép dịch vụ chép lời. Bản ghi âm vẫn tiếp tục.');
      } else if (code === 'language-not-supported') {
        wanted = false;
        onError?.('fatal', 'Dịch vụ chép lời của trình duyệt không hỗ trợ tiếng Việt.');
      } else if (code === 'audio-capture') {
        wanted = false;
        onError?.('fatal', 'Dịch vụ chép lời không truy cập được micro.');
      } else if (code === 'network') {
        onError?.('transient', 'Mất kết nối tới dịch vụ chép lời, đang thử lại…');
      } else {
        onError?.('transient', 'Dịch vụ chép lời gặp lỗi, đang thử lại…');
      }
    };
    r.onend = () => {
      if (r !== rec) return;
      rec = null;
      onInterim?.('');
      if (wanted && !restartTimer) restartTimer = setTimeout(spawn, 250);
    };
    try {
      r.start();
    } catch {
      rec = null;
      if (wanted && !restartTimer) restartTimer = setTimeout(spawn, 1000);
    }
  };

  return {
    start() {
      if (wanted) return;
      wanted = true;
      recent = [];
      if (!rec && !restartTimer) spawn();
    },
    /** Graceful: pending final results still arrive, then no restart. */
    stop() {
      wanted = false;
      clearTimeout(restartTimer);
      restartTimer = 0;
      try { rec?.stop(); } catch { /* already stopped */ }
    },
    abort() {
      wanted = false;
      clearTimeout(restartTimer);
      restartTimer = 0;
      const r = rec;
      rec = null;
      try { r?.abort(); } catch { /* ignore */ }
    },
    get active() { return wanted; },
  };
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

const MIC_SVG = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>');

const STATUS = {
  idle: 'Sẵn sàng ghi',
  requesting: 'Đang xin quyền dùng micro…',
  recording: 'Đang ghi',
  paused: 'Đã tạm dừng',
  stopped: 'Đã dừng — xem lại rồi lưu vào ghi chú',
  saving: 'Đang tải bản ghi lên…',
  done: 'Đã lưu',
  error: 'Có lỗi',
};

const DIRTY = new Set(['requesting', 'recording', 'paused', 'stopped', 'saving']);

const fmtMB = (bytes) => (bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`);

function readMicPref() {
  try { return G.localStorage?.getItem(MIC_PREF_KEY) || ''; } catch { return ''; }
}
function writeMicPref(id) {
  try { if (id) G.localStorage?.setItem(MIC_PREF_KEY, id); else G.localStorage?.removeItem(MIC_PREF_KEY); } catch { /* private mode */ }
}

/**
 * Open the recorder dialog.
 * @param {object} o
 * @param {string} o.noteId
 * @param {(noteId:string, blob:Blob, meta:{mimeType:string,durationSec:number}) => Promise<{url:string}>} o.uploadAudio
 * @param {(markdown:string) => void} o.onInsert
 * @param {(err:any) => void} [o.onError]  informational; errors are already shown in the dialog
 * @param {() => Promise<boolean>} [o.confirmDiscard]  override of the discard confirmation (tests)
 */
export function openRecorder({ noteId, uploadAudio, onInsert, onError, confirmDiscard } = {}) {
  const nav = G.navigator || {};
  const canTranscribe = isTranscriptionSupported();
  const prevFocus = G.document.activeElement;

  const el = fragment(html`
    <dialog class="dialog rec" data-state="idle" aria-labelledby="rec-title" aria-describedby="rec-status">
      <header class="dialog__head">
        <div>
          <span class="eyebrow">Ghi chú</span>
          <h2 id="rec-title">Ghi âm cuộc họp</h2>
        </div>
        <button type="button" class="icon-btn" data-act="close" aria-label="Đóng">${icon('x')}</button>
      </header>
      <div class="dialog__body rec__body">
        <div class="rec__stage">
          <span class="rec__dot" aria-hidden="true"></span>
          <div class="rec__timer tnum" role="timer" aria-label="Thời gian đã ghi" data-role="timer">00:00</div>
          <div class="rec__status" id="rec-status" role="status" aria-live="polite" data-role="status">${STATUS.idle}</div>
          <div class="rec__meter" aria-hidden="true" data-role="meter"><span class="rec__meter-fill"></span></div>
          <p class="rec__hint" data-role="hint" aria-live="polite" hidden></p>
        </div>
        <p class="rec__msg" role="alert" data-role="msg" hidden></p>

        <div class="rec__controls">
          <button type="button" class="btn btn--accent btn--lg rec__start" data-act="start">${MIC_SVG}<span>Bắt đầu ghi</span></button>
          <button type="button" class="btn btn--accent btn--lg" data-act="retry-mic" hidden>${icon('refresh')}<span>Thử lại</span></button>
          <button type="button" class="btn btn--lg" data-act="pause" hidden>${icon('pause')}<span>Tạm dừng</span></button>
          <button type="button" class="btn btn--lg" data-act="resume" hidden>${icon('play')}<span>Tiếp tục</span></button>
          <button type="button" class="btn btn--lg" data-act="mark" hidden title="Thêm dấu mốc tại thời điểm hiện tại">${icon('flag')}<span>Đánh dấu</span></button>
          <button type="button" class="btn btn--danger btn--lg" data-act="stop" hidden>${icon('stop')}<span>Dừng</span></button>
        </div>

        <div class="rec__opts" data-role="opts">
          <div class="field rec__mic">
            <label class="field__label" for="rec-mic">Micro</label>
            <select id="rec-mic" class="select" data-role="mic"><option value="">Micro mặc định</option></select>
          </div>
          <div class="rec__tr">
            <label class="rec__switch">
              <input type="checkbox" data-role="transcribe" ${canTranscribe ? '' : raw('disabled')} />
              <span>Chép lời trực tiếp (tiếng Việt)</span>
            </label>
            <p class="rec__note muted">${canTranscribe
              ? 'Khi bật, âm thanh được gửi tới dịch vụ nhận dạng giọng nói của trình duyệt (ví dụ máy chủ của Google) để chép lời. Không bật cho cuộc họp có nội dung nhạy cảm.'
              : 'Trình duyệt này không hỗ trợ chép lời trực tiếp (hãy dùng Chrome hoặc Edge). Bạn vẫn ghi âm và đánh dấu được.'}</p>
          </div>
        </div>

        <audio class="rec__preview" data-role="preview" controls preload="metadata" hidden></audio>

        <section class="rec__transcript" data-role="transcript" aria-labelledby="rec-tr-title" hidden>
          <h3 id="rec-tr-title" class="rec__tr-title">Bản chép lời <span class="muted">· sửa được trước khi lưu</span></h3>
          <ol class="rec__lines" data-role="lines"></ol>
          <p class="rec__interim" data-role="interim" aria-hidden="true"></p>
          <p class="rec__empty muted" data-role="empty">Chưa có lời nào được chép.</p>
        </section>
      </div>
      <footer class="dialog__foot rec__foot">
        <button type="button" class="btn btn--ghost" data-act="download" hidden>${icon('download')}<span>Tải tệp ghi âm</span></button>
        <div class="grow"></div>
        <button type="button" class="btn btn--ghost" data-act="discard">Hủy</button>
        <button type="button" class="btn" data-act="transcript-only" hidden>Chỉ chèn bản chép lời</button>
        <button type="button" class="btn btn--primary" data-act="retry-save" hidden>${icon('refresh')}<span>Thử lại</span></button>
        <button type="button" class="btn btn--primary" data-act="save" hidden>Lưu vào ghi chú</button>
      </footer>
    </dialog>`);

  const $ = (sel) => el.querySelector(sel);
  const role = (r) => $(`[data-role="${r}"]`);
  const act = (a) => $(`[data-act="${a}"]`);
  const ui = {
    timer: role('timer'), status: role('status'), meter: role('meter'), hint: role('hint'), msg: role('msg'),
    mic: role('mic'), transcribe: role('transcribe'), preview: role('preview'), transcript: role('transcript'),
    lines: role('lines'), interim: role('interim'), empty: role('empty'),
  };

  /* ---------- session state ---------- */
  let state = 'idle';
  let errorKind = null;          // 'mic' | 'upload'
  let closed = false;
  let confirming = false;
  let stream = null;
  let mr = null;
  let mime = '';
  let chunks = [];
  let blob = null;
  let blobUrl = '';
  let startedAt = null;
  let accMs = 0;                 // recorded time before the current run
  let runStart = 0;              // Date.now() when the current run started (recording only)
  let stopping = false;
  let discarding = false;
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let levelBuf = null;
  let tick = 0;
  let warned = false;
  let silentSince = 0;
  let wake = null;
  let wakePending = false;
  let transcriber = null;
  let entries = [];              // { id, t, kind, text }
  let seq = 0;
  let uploadedUrl = '';
  let stopReason = '';

  const elapsedMs = () => accMs + (state === 'recording' && !stopping ? Date.now() - runStart : 0);
  const elapsedSec = () => elapsedMs() / 1000;
  const durationSec = () => Math.floor(accMs / 1000);

  /* ---------- rendering ---------- */
  const show = (node, on) => { if (node) node.hidden = !on; };

  function setMsg(text, tone = 'error') {
    ui.msg.textContent = text || '';
    ui.msg.dataset.tone = tone;
    ui.msg.hidden = !text;
  }

  function render() {
    el.dataset.state = state;
    const s = state;
    const live = s === 'recording' || s === 'paused';
    show(act('start'), s === 'idle' || s === 'requesting');
    act('start').disabled = s === 'requesting';
    show(act('retry-mic'), s === 'error' && errorKind === 'mic');
    show(act('pause'), s === 'recording');
    show(act('resume'), s === 'paused');
    show(act('mark'), live);
    show(act('stop'), live);
    act('stop').disabled = stopping;
    act('pause').disabled = stopping;
    act('mark').disabled = stopping;
    ui.mic.disabled = !(s === 'idle' || (s === 'error' && errorKind === 'mic'));
    show(role('opts'), s === 'idle' || s === 'requesting' || live || (s === 'error' && errorKind === 'mic'));
    ui.transcribe.disabled = !canTranscribe || stopping || !(s === 'idle' || live || (s === 'error' && errorKind === 'mic'));

    const reviewing = s === 'stopped' || s === 'saving' || (s === 'error' && errorKind === 'upload');
    show(ui.preview, reviewing && !!blobUrl);
    show(act('save'), s === 'stopped' || s === 'saving');
    const saveBtn = act('save');
    saveBtn.disabled = s === 'saving' || !blob || !blob.size || blob.size > AUDIO_MAX;
    saveBtn.classList.toggle('is-loading', s === 'saving');
    saveBtn.setAttribute('aria-busy', s === 'saving' ? 'true' : 'false');
    show(act('retry-save'), s === 'error' && errorKind === 'upload');
    const hasLines = entries.some((e) => e.kind === 'mark' || e.text.trim());
    const uploadImpossible = (s === 'error' && errorKind === 'upload' && !uploadedUrl) || (s === 'stopped' && !!blob && (blob.size > AUDIO_MAX || !blob.size));
    show(act('transcript-only'), hasLines && uploadImpossible);
    show(act('download'), reviewing && !!blob && !!blob.size);
    act('discard').textContent = s === 'stopped' || s === 'error' && errorKind === 'upload' ? 'Bỏ bản ghi' : 'Hủy';
    act('discard').disabled = s === 'saving';

    show(ui.transcript, entries.length > 0 || (ui.transcribe.checked && (live || reviewing)));
    show(ui.empty, entries.length === 0);
    if (!live) ui.interim.textContent = '';

    let status = STATUS[s];
    if (s === 'saving' && blob) status = `Đang tải bản ghi lên (${fmtMB(blob.size)})…`;
    if (s === 'stopped' && blob) status = `Đã dừng · ${fmtElapsed(durationSec())} · ${fmtMB(blob.size)}`;
    if (stopping) status = 'Đang hoàn tất bản ghi…';
    if (ui.status.textContent !== status) ui.status.textContent = status;
    renderClock();
  }

  function renderClock() {
    const t = fmtElapsed(s0(elapsedSec()));
    if (ui.timer.textContent !== t) ui.timer.textContent = t;
  }
  const s0 = (x) => Math.floor(x);

  function setLevel(v) {
    const q = Math.round(v * 20) / 20;  // quantised: fewer repaints, calmer for reduced motion
    ui.meter.style.setProperty('--level', String(q));
    ui.meter.dataset.level = String(q);
  }

  function go(next, extra = {}) {
    if (closed) return false;
    if (next !== state && !TRANSITIONS[state]?.includes(next)) return false;
    state = next;
    if ('errorKind' in extra) errorKind = extra.errorKind;
    render();
    return true;
  }

  /* ---------- transcript list ---------- */
  function lineNode(e) {
    const stamp = fmtStamp(e.t);
    const li = fragment(html`
      <li class="rec__line ${e.kind === 'mark' ? 'rec__line--mark' : ''}" data-id="${e.id}" data-t="${e.t}">
        <span class="rec__ts tnum">[${stamp}]</span>
        ${e.kind === 'mark' ? html`<span class="rec__star" aria-hidden="true">⭐</span>` : ''}
        <input class="input rec__line-input" type="text" value="${e.text}"
          aria-label="${e.kind === 'mark' ? `Ghi chú cho dấu mốc ${stamp}` : `Lời tại ${stamp}`}"
          ${e.kind === 'mark' ? raw('placeholder="Đánh dấu — thêm ghi chú (không bắt buộc)"') : ''} />
        <button type="button" class="icon-btn icon-btn--sm" data-act="del-line" aria-label="Xóa dòng ${stamp}">${icon('x')}</button>
      </li>`);
    return li;
  }

  function addEntry(kind, t, text) {
    const e = { id: `e${++seq}`, t: Math.max(0, Math.floor(t)), kind, text: text || '' };
    entries.push(e);
    const node = lineNode(e);
    const after = [...ui.lines.children].find((li) => Number(li.dataset.t) > e.t);
    ui.lines.insertBefore(node, after || null);
    render();
    return { e, node };
  }

  ui.lines.addEventListener('input', (ev) => {
    const li = ev.target.closest('li[data-id]');
    const e = li && entries.find((x) => x.id === li.dataset.id);
    if (e) e.text = ev.target.value;
  });

  /* ---------- resources ---------- */
  function stopTracks() {
    stream?.getTracks?.().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
    stream = null;
  }

  function closeAudio() {
    try { sourceNode?.disconnect?.(); } catch { /* ignore */ }
    const ctx = audioCtx;
    audioCtx = null; analyser = null; sourceNode = null;
    if (ctx && ctx.state !== 'closed') {
      try { ctx.close?.()?.catch?.(() => {}); } catch { /* ignore */ }
    }
    setLevel(0);
  }

  function setupMeter() {
    const Ctx = AC();
    if (!Ctx || !stream) return;
    try {
      audioCtx = new Ctx();
      sourceNode = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      sourceNode.connect(analyser);
      levelBuf = new Float32Array(analyser.fftSize);
      audioCtx.resume?.()?.catch?.(() => {});
    } catch {
      closeAudio(); // meter is optional
    }
  }

  async function lockOn() {
    if (wake || wakePending || !nav.wakeLock?.request) return;
    wakePending = true;
    try {
      const w = await nav.wakeLock.request('screen');
      if (closed || state !== 'recording') { w.release?.()?.catch?.(() => {}); return; }
      wake = w;
      w.addEventListener?.('release', () => { if (wake === w) wake = null; });
    } catch { /* battery saver / not visible: fine */ } finally { wakePending = false; }
  }
  function lockOff() {
    const w = wake;
    wake = null;
    try { w?.release?.()?.catch?.(() => {}); } catch { /* ignore */ }
  }
  const onVisibility = () => { if (G.document.visibilityState === 'visible' && state === 'recording') lockOn(); };

  const onBeforeUnload = (e) => {
    if (closed) return;
    if (DIRTY.has(state) || (state === 'error' && errorKind === 'upload')) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  };

  /* ---------- devices ---------- */
  async function fillDevices() {
    const md = nav.mediaDevices;
    if (!md?.enumerateDevices) return;
    let list = [];
    try { list = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { return; }
    if (closed) return;
    const pref = ui.mic.value || readMicPref();
    const named = list.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const opts = [html`<option value="">Micro mặc định</option>`];
    named.forEach((d, i) => opts.push(html`<option value="${d.deviceId}">${d.label || `Micro ${i + 1}`}</option>`));
    ui.mic.innerHTML = String(html`${opts}`);
    ui.mic.value = named.some((d) => d.deviceId === pref) ? pref : '';
  }
  ui.mic.addEventListener('change', () => writeMicPref(ui.mic.value));

  /* ---------- transcription ---------- */
  function ensureTranscriber() {
    if (transcriber || !canTranscribe) return transcriber;
    transcriber = createTranscriber({
      getTime: () => elapsedSec(),
      onFinal: ({ t, text }) => { if (!closed) addEntry('speech', t, text); },
      onInterim: (text) => { if (!closed) ui.interim.textContent = text; },
      onError: (kind, message) => {
        if (closed) return;
        if (kind === 'fatal' || kind === 'unstable') {
          ui.transcribe.checked = false;
          render();
        }
        showHint(message, kind === 'transient' ? 4000 : 8000);
      },
    });
    return transcriber;
  }

  let hintTimer = 0;
  function showHint(text, ms = 0) {
    clearTimeout(hintTimer);
    ui.hint.textContent = text || '';
    ui.hint.hidden = !text;
    if (text && ms) hintTimer = setTimeout(() => { if (!closed) showHint(''); }, ms);
  }

  ui.transcribe.addEventListener('change', () => {
    if (ui.transcribe.checked && state === 'recording') ensureTranscriber()?.start();
    if (!ui.transcribe.checked) transcriber?.stop();
    render();
  });

  /* ---------- recording ---------- */
  function fail(kind, err, message) {
    errorKind = kind;
    setMsg(message);
    try { onError?.(err); } catch { /* page logger must not break the dialog */ }
  }

  async function start() {
    if (state !== 'idle' && !(state === 'error' && errorKind === 'mic')) return;
    setMsg('');
    if (!go('requesting', { errorKind: null })) return;
    try {
      if (G.isSecureContext === false) throw Object.assign(new Error('insecure'), { name: 'insecure' });
      if (!nav.mediaDevices?.getUserMedia || typeof G.MediaRecorder !== 'function') {
        throw Object.assign(new Error('unsupported'), { name: 'unsupported' });
      }
      const deviceId = ui.mic.value;
      const s = await nav.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
          echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
        },
      });
      if (closed) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      mime = pickMimeType();
      try {
        mr = new G.MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: AUDIO_BITS });
      } catch {
        mime = '';
        try { mr = new G.MediaRecorder(stream, { audioBitsPerSecond: AUDIO_BITS }); } catch (e2) {
          throw Object.assign(new Error(e2?.message || 'recorder'), { name: 'recorder' });
        }
      }
      chunks = [];
      mr.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
      mr.onstop = () => finalize();
      mr.onerror = (ev) => {
        if (closed) return;
        stopReason = 'error';
        setMsg('Bộ ghi âm gặp lỗi nên đã dừng. Phần đã ghi được vẫn được giữ lại.', 'warn');
        try { onError?.(ev?.error || ev); } catch { /* ignore */ }
        stop();
      };
      stream.getAudioTracks?.().forEach((t) => t.addEventListener?.('ended', onTrackEnded));
      setupMeter();
      mr.start(TIMESLICE_MS);
      startedAt = new Date();
      accMs = 0;
      runStart = Date.now();
      warned = false;
      silentSince = Date.now();
      go('recording');
      fillDevices();
      lockOn();
      if (ui.transcribe.checked) ensureTranscriber()?.start();
      clearInterval(tick);
      tick = setInterval(onTick, TICK_MS);
    } catch (err) {
      stopTracks();
      closeAudio();
      mr = null;
      if (closed) return;
      fail('mic', err, micErrorMessage(err));
      go('error', { errorKind: 'mic' });
      fillDevices();
    }
  }

  function onTrackEnded() {
    if (closed || (state !== 'recording' && state !== 'paused')) return;
    stopReason = 'device';
    setMsg('Micro đã bị ngắt nên bản ghi đã dừng. Phần đã ghi được vẫn được giữ lại.', 'warn');
    stop();
  }

  function onTick() {
    if (closed) return;
    renderClock();
    if (state !== 'recording' || stopping) return;
    const sec = elapsedSec();
    if (analyser && levelBuf) {
      const lv = levelFromAnalyser(analyser, levelBuf);
      setLevel(lv);
      const now = Date.now();
      if (lv > 0.12) { silentSince = now; if (ui.hint.dataset.kind === 'silence') { ui.hint.dataset.kind = ''; showHint(''); } }
      else if (now - silentSince > SILENCE_HINT_MS && ui.hint.hidden) {
        showHint('Không thu được âm thanh — kiểm tra micro đã bật và đúng thiết bị chưa.');
        ui.hint.dataset.kind = 'silence';
      }
    }
    if (sec >= MAX_SEC) {
      stopReason = 'max';
      setMsg('Đã đạt giới hạn 60 phút nên bản ghi đã tự dừng. Hãy lưu bản này rồi ghi tiếp một bản mới.', 'warn');
      stop();
    } else if (sec >= WARN_SEC && !warned) {
      warned = true;
      setMsg('Còn 5 phút nữa là đến giới hạn 60 phút — bản ghi sẽ tự dừng.', 'warn');
    }
  }

  function pause() {
    if (state !== 'recording' || stopping) return;
    try { mr?.pause(); } catch { /* ignore */ }
    accMs += Date.now() - runStart;
    transcriber?.stop();
    lockOff();
    setLevel(0);
    go('paused');
  }

  function resume() {
    if (state !== 'paused' || stopping) return;
    try { mr?.resume(); } catch { /* ignore */ }
    runStart = Date.now();
    silentSince = Date.now();
    go('recording');
    lockOn();
    if (ui.transcribe.checked) ensureTranscriber()?.start();
  }

  function stop() {
    if ((state !== 'recording' && state !== 'paused') || stopping) return;
    if (state === 'recording') accMs += Date.now() - runStart;
    stopping = true;
    accMs = Math.min(accMs, MAX_SEC * 1000);
    transcriber?.stop();
    lockOff();
    clearInterval(tick);
    tick = 0;
    setLevel(0);
    render();
    if (mr && mr.state !== 'inactive') {
      try { mr.stop(); return; } catch { /* fall through */ }
    }
    finalize();
  }

  async function finalize() {
    if (closed || discarding) return;
    if (!stopping) { // recorder stopped by itself (error / track gone) without stop()
      if (state !== 'recording' && state !== 'paused') return;
      if (state === 'recording') accMs += Date.now() - runStart;
      stopping = true;
      render();
    }
    const type = baseMime(mr?.mimeType) || baseMime(mime) || 'audio/webm';
    stopTracks();
    closeAudio();
    transcriber?.stop();
    clearInterval(tick);
    tick = 0;
    // Chrome's MediaRecorder WebM has no Duration → players show no length and
    // cannot seek; write it into the header (best effort, original on failure).
    const assembled = await fixWebmDuration(new Blob(chunks, { type }), accMs);
    if (closed) return;
    blob = assembled;
    try { blobUrl = G.URL?.createObjectURL?.(blob) || ''; } catch { blobUrl = ''; }
    if (blobUrl) ui.preview.src = blobUrl;
    stopping = false;
    go('stopped');
    if (!blob.size) setMsg('Bản ghi trống — không thu được dữ liệu âm thanh.', 'error');
    else if (blob.size > AUDIO_MAX) setMsg(`Bản ghi ${fmtMB(blob.size)} vượt giới hạn 25 MB nên không tải lên được. Hãy tải tệp về máy.`, 'error');
    else if (!stopReason) setMsg('');
    act('save').focus?.();
  }

  function addBookmark() {
    if ((state !== 'recording' && state !== 'paused') || stopping) return;
    const { node } = addEntry('mark', elapsedSec(), '');
    ui.status.textContent = `Đã đánh dấu ${fmtStamp(elapsedSec())}`;
    node.querySelector('input')?.focus?.();
  }

  /* ---------- saving ---------- */
  function entriesForMd() {
    return entries.map(({ t, kind, text }) => ({ t, kind, text }));
  }

  async function save() {
    if (!blob || !blob.size || blob.size > AUDIO_MAX) return;
    if (state !== 'stopped' && !(state === 'error' && errorKind === 'upload')) return;
    setMsg('');
    if (!go('saving', { errorKind: null })) return;
    try {
      if (!uploadedUrl) {
        if (typeof uploadAudio !== 'function' || !noteId) throw new Error('Ghi chú chưa sẵn sàng để lưu tệp.');
        const res = await uploadAudio(noteId, blob, { mimeType: blob.type || baseMime(mime) || 'audio/webm', durationSec: durationSec() });
        if (!res?.url) throw new Error('Máy chủ không trả về địa chỉ tệp.');
        uploadedUrl = res.url;
      }
      if (closed) return;
      const md = buildRecordingMarkdown({ startedAt, durationSec: durationSec(), url: uploadedUrl, entries: entriesForMd() });
      onInsert?.(md);
    } catch (err) {
      if (closed) return;
      const why = err?.message ? ` (${err.message})` : '';
      fail('upload', err, uploadedUrl
        ? `Đã tải tệp lên nhưng không chèn được vào ghi chú${why}. Bấm "Thử lại".`
        : `Không tải được bản ghi lên${why}. Bản ghi vẫn được giữ — bạn có thể thử lại, tải tệp về máy${entries.length ? ' hoặc chỉ chèn bản chép lời' : ''}.`);
      go('error', { errorKind: 'upload' });
      act('retry-save').focus?.();
      return;
    }
    go('done');
    toast('Đã chèn bản ghi âm vào ghi chú');
    destroy();
  }

  function insertTranscriptOnly() {
    if (!entries.length) return;
    const md = buildRecordingMarkdown({ startedAt, durationSec: durationSec(), url: null, entries: entriesForMd() });
    try {
      onInsert?.(md);
    } catch (err) {
      fail('upload', err, `Không chèn được bản chép lời${err?.message ? ` (${err.message})` : ''}.`);
      return;
    }
    go('done');
    toast.info('Đã chèn bản chép lời (không kèm tệp ghi âm)');
    destroy();
  }

  function download() {
    if (!blob) return;
    const ext = { 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }[blob.type] || 'webm';
    const stamp = startedAt ? `${dayOf(startedAt)}-${meetingWhen(startedAt).time.replace(':', '')}` : 'ghi-am';
    const a = G.document.createElement('a');
    a.href = blobUrl || G.URL.createObjectURL(blob);
    a.download = `ghi-am-${stamp}.${ext}`;
    a.rel = 'noopener';
    G.document.body.append(a);
    a.click();
    a.remove();
  }

  /* ---------- closing ---------- */
  function hasUnsaved() {
    if (state === 'recording' || state === 'paused' || state === 'saving') return true;
    if (state === 'stopped') return !!blob?.size || entries.length > 0;
    if (state === 'error' && errorKind === 'upload') return true;
    return false;
  }

  async function requestClose() {
    if (closed || confirming) return;
    if (!hasUnsaved()) { destroy(); return; }
    confirming = true;
    let ok = false;
    try {
      const ask = confirmDiscard || (() => confirmDialog({
        title: 'Bỏ bản ghi này?',
        message: state === 'recording' || state === 'paused'
          ? 'Bản ghi đang thực hiện và chưa được lưu. Nếu bỏ, toàn bộ âm thanh và bản chép lời sẽ mất.'
          : 'Bản ghi chưa được lưu vào ghi chú. Nếu bỏ, toàn bộ âm thanh và bản chép lời sẽ mất.',
        confirmLabel: 'Bỏ bản ghi',
        cancelLabel: 'Quay lại',
        danger: true,
      }));
      ok = await ask();
    } finally {
      confirming = false;
    }
    if (ok) destroy();
    else if (!closed) el.querySelector('[data-act]:not([hidden]):not(:disabled)')?.focus?.();
  }

  function destroy() {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    clearTimeout(hintTimer);
    transcriber?.abort();
    if (mr && mr.state !== 'inactive') {
      discarding = true;
      try { mr.stop(); } catch { /* ignore */ }
    }
    if (mr) { mr.ondataavailable = null; mr.onstop = null; mr.onerror = null; }
    stream?.getAudioTracks?.().forEach((t) => t.removeEventListener?.('ended', onTrackEnded));
    stopTracks();
    closeAudio();
    lockOff();
    G.removeEventListener?.('beforeunload', onBeforeUnload);
    G.document.removeEventListener('visibilitychange', onVisibility);
    if (blobUrl) { try { G.URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } }
    blobUrl = '';
    blob = null;
    chunks = [];
    try { el.close?.(); } catch { /* not open */ }
    el.remove();
    try { prevFocus?.focus?.(); } catch { /* gone */ }
  }

  /* ---------- events ---------- */
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    switch (b.dataset.act) {
      case 'start': case 'retry-mic': start(); break;
      case 'pause': pause(); break;
      case 'resume': resume(); break;
      case 'stop': stop(); break;
      case 'mark': addBookmark(); break;
      case 'save': case 'retry-save': save(); break;
      case 'transcript-only': insertTranscriptOnly(); break;
      case 'download': download(); break;
      case 'close': case 'discard': requestClose(); break;
      case 'del-line': {
        const li = b.closest('li[data-id]');
        if (!li) break;
        entries = entries.filter((x) => x.id !== li.dataset.id);
        const next = li.nextElementSibling || li.previousElementSibling;
        li.remove();
        render();
        (next?.querySelector('input') || act('save'))?.focus?.();
        break;
      }
      default:
    }
  });

  const focusables = () => [...el.querySelectorAll('button, select, input, textarea, audio[controls], [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && !n.closest('[hidden]'));

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const cur = G.document.activeElement;
      if (e.shiftKey && (cur === first || !el.contains(cur))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || !el.contains(cur))) { e.preventDefault(); first.focus(); }
      return;
    }
    // Enter in a transcript line must not trigger anything else.
    if (e.key === 'Enter' && e.target.classList?.contains('rec__line-input')) e.preventDefault();
  });
  el.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); });

  G.addEventListener?.('beforeunload', onBeforeUnload);
  G.document.addEventListener('visibilitychange', onVisibility);

  G.document.body.append(el);
  try { el.showModal(); } catch { el.setAttribute('open', ''); }
  render();
  fillDevices();
  act('start').focus?.();

  return {
    close: destroy,
    el,
    get state() { return state; },
  };
}
