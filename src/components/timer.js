// Timer controller shared by the topbar chip, the Time page and task rows.
// Model (see ARCHITECTURE §4.3): a session is a list of segments.
//   start  → insert segment          pause → close segment
//   resume → insert new segment       stop  → close segment, forget session
// "Paused" state lives in localStorage (it has no DB representation).
//
// Pomodoro is layered on the very same segments: a focus phase is simply the
// running segment(s); when it ends the segment is closed (= pause) and a break
// countdown runs locally. Nothing about Pomodoro is stored in the database.
import * as store from '../core/store.js';
import { getRunningEntry, startEntry, stopEntry, updateEntry } from '../services/timeEntries.js';
import { getTask } from '../services/tasks.js';
import { today } from '../utils/date.js';
import { toast } from './toast.js';

const KEY = 'nm.pausedSession';
const POMO_KEY = 'nm.pomodoro';
const POMO_CFG_KEY = 'nm.pomodoro.cfg';
const POMO_LOG_KEY = 'nm.pomodoro.log';
const tickers = new Set();
const pomoSubs = new Set();
let interval = null;

function readJSON(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function writeJSON(key, v) {
  try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

// Server clock − local clock (ms). started_at is stamped by Postgres now(), so a
// device clock that runs behind would show 00:00 for several seconds after start.
const SKEW_KEY = 'nm.clockSkew';
let skew = Number(readJSON(SKEW_KEY, 0)) || 0;
export function serverNow() { return Date.now() + skew; }
/** Call around an RPC that returns a fresh server-stamped started_at. */
function learnSkew(startedAt, t0, t1) {
  const s = Date.parse(startedAt);
  if (!Number.isFinite(s)) return;
  const est = s - (t0 + t1) / 2;
  // Ignore jitter within the request time; clamp absurd values.
  skew = Math.abs(est) <= Math.max(500, (t1 - t0) / 2) ? 0 : Math.max(-600000, Math.min(600000, Math.round(est)));
  writeJSON(SKEW_KEY, skew);
}

function readPaused() { return readJSON(KEY); }
function writePaused(v) { writeJSON(KEY, v || null); }

export function pausedSession() {
  return readPaused();
}

async function withTask(entry) {
  if (!entry) return null;
  let task = null;
  if (entry.task_id) {
    try { task = await getTask(entry.task_id); } catch { task = null; }
  }
  return { ...entry, task };
}

export async function refreshRunning() {
  const e = await getRunningEntry();
  store.set({ runningEntry: await withTask(e) });
  reconcilePomodoro();
  syncTicker();
  return store.get().runningEntry;
}

/** Start a fresh timer. Any running one is closed first. */
export async function start({ taskId = null, description = null } = {}) {
  unlockAudio();
  // start_timer closes any running segment atomically on the server.
  const t0 = Date.now();
  const e = await startEntry({ task_id: taskId, description });
  learnSkew(e?.started_at, t0, Date.now());
  writePaused(null);
  if (pomo.enabled) setPomo({ phase: 'focus', base: 0, cycle: 0, breakEndsAt: null });
  store.set({ runningEntry: await withTask(e) });
  syncTicker();
  return e;
}

/** Close the running segment and remember the session as paused. `endAt` (ms) trims an overrun. */
async function closeSegment(endAt = null) {
  const cur = store.get().runningEntry;
  if (!cur) return null;
  let closed = await stopEntry(cur);
  if (closed && endAt) {
    const start = Date.parse(closed.started_at);
    const target = Math.max(start + 1000, endAt);
    if (Date.parse(closed.ended_at) - target > 3000) {
      try { closed = await updateEntry(closed.id, { ended_at: new Date(target).toISOString() }); } catch { /* keep untrimmed */ }
    }
  }
  const prev = readPaused();
  const secs = (closed?.duration_seconds ?? 0) + (prev && prev.task_id === cur.task_id ? prev.seconds || 0 : 0);
  writePaused({ task_id: cur.task_id, description: cur.description, title: cur.task?.title || cur.description || '', seconds: secs, at: Date.now() });
  store.set({ runningEntry: null });
  return closed;
}

export async function pause() {
  if (!store.get().runningEntry) return;
  await closeSegment();
  syncTicker();
}

export async function resume() {
  unlockAudio();
  const p = readPaused();
  if (!p) return;
  let e;
  try {
    const t0 = Date.now();
    e = await startEntry({ task_id: p.task_id, description: p.description });
    learnSkew(e?.started_at, t0, Date.now());
  } catch (err) {
    // The task was completed, cancelled or deleted while paused: the session cannot continue.
    if (err?.code === 'task_closed' || err?.code === 'not_found') {
      writePaused(null);
      setPomo({ phase: 'idle', base: 0, cycle: 0, breakEndsAt: null });
      syncTicker();
      tickers.forEach((fn) => fn());
    }
    throw err;
  }
  if (pomo.enabled && pomo.phase !== 'focus') setPomo({ phase: 'focus', base: p.seconds || 0, breakEndsAt: null });
  store.set({ runningEntry: await withTask(e) });
  syncTicker();
}

export async function stop() {
  const cur = store.get().runningEntry;
  if (cur) await stopEntry(cur);
  writePaused(null);
  setPomo({ phase: 'idle', base: 0, cycle: 0, breakEndsAt: null });
  store.set({ runningEntry: null });
  syncTicker();
}

export function discardPaused() {
  writePaused(null);
  setPomo({ phase: 'idle', base: 0, cycle: 0, breakEndsAt: null });
  tickers.forEach((fn) => fn());
  syncTicker();
}

/** Elapsed seconds of the current session (paused segments + running one). */
export function sessionSeconds() {
  const cur = store.get().runningEntry;
  const p = readPaused();
  const carried = p && cur && p.task_id === cur.task_id ? p.seconds || 0 : 0;
  if (!cur) return p?.seconds || 0;
  return carried + Math.max(0, Math.floor((serverNow() - new Date(cur.started_at).getTime()) / 1000));
}

export function onTick(fn) {
  tickers.add(fn);
  syncTicker();
  return () => { tickers.delete(fn); syncTicker(); };
}

function syncTicker() {
  const need = !!store.get().runningEntry || pomo.phase === 'break';
  if (need && !interval) interval = setInterval(tick, 1000);
  if (!need && interval) { clearInterval(interval); interval = null; }
  if (store.get().runningEntry || tickers.size) tickers.forEach((fn) => fn());
  emitPomo();
  updateTitle();
}

function tick() {
  if (store.get().runningEntry) tickers.forEach((fn) => fn());
  checkPhase();
  emitPomo();
  updateTitle();
}

// Paused session must keep its carried seconds when resumed:
// keep the paused record while running so sessionSeconds() can add it, and
// clear it only on stop/start-new.

/* ==================================================================== */
/* Pomodoro                                                              */
/* ==================================================================== */

export const POMODORO_DEFAULTS = { focus: 25, short: 5, long: 15, every: 4, autoFocus: false, sound: true, notify: true };

let cfg = { ...POMODORO_DEFAULTS, ...readJSON(POMO_CFG_KEY, {}) };
// phase: idle | focus | break | ready (break over, waiting for the next focus)
let pomo = { enabled: false, phase: 'idle', base: 0, cycle: 0, breakEndsAt: null, breakKind: 'short', breakTotal: 0, ...readJSON(POMO_KEY, {}) };
let busy = false;
let failedAt = 0;

function setPomo(patch) {
  pomo = { ...pomo, ...patch };
  writeJSON(POMO_KEY, pomo);
}

export function pomodoroConfig() {
  return { ...cfg };
}

export function setPomodoroConfig(patch = {}) {
  const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  cfg = {
    ...cfg,
    ...patch,
    focus: clamp(patch.focus ?? cfg.focus, 1, 180, POMODORO_DEFAULTS.focus),
    short: clamp(patch.short ?? cfg.short, 1, 60, POMODORO_DEFAULTS.short),
    long: clamp(patch.long ?? cfg.long, 1, 90, POMODORO_DEFAULTS.long),
    every: clamp(patch.every ?? cfg.every, 2, 12, POMODORO_DEFAULTS.every),
  };
  writeJSON(POMO_CFG_KEY, cfg);
  syncTicker();
  return { ...cfg };
}

/** 'stopwatch' | 'pomodoro' */
export function timerMode() {
  return pomo.enabled ? 'pomodoro' : 'stopwatch';
}

export function setTimerMode(mode) {
  const enabled = mode === 'pomodoro';
  if (enabled === pomo.enabled) return;
  if (enabled) {
    requestNotifyPermission();
    unlockAudio();
    // A running stopwatch becomes a focus phase that starts now.
    setPomo({ enabled, phase: store.get().runningEntry || readPaused() ? 'focus' : 'idle', base: sessionSeconds(), cycle: 0, breakEndsAt: null });
  } else {
    setPomo({ enabled, phase: 'idle', base: 0, cycle: 0, breakEndsAt: null });
  }
  syncTicker();
}

function todayLog() {
  const log = readJSON(POMO_LOG_KEY, {});
  return Number(log[today()]) || 0;
}
function bumpLog() {
  const log = readJSON(POMO_LOG_KEY, {});
  const d = today();
  log[d] = (Number(log[d]) || 0) + 1;
  // keep ~60 days
  Object.keys(log).sort().slice(0, -60).forEach((k) => delete log[k]);
  writeJSON(POMO_LOG_KEY, log);
}

/**
 * Snapshot for the UI:
 * { enabled, phase, remaining, total, elapsed, cycle, every, breakKind, todayCount, cfg }
 * For a focus phase, `remaining` freezes while the session is paused.
 */
export function pomodoro() {
  const focusTotal = cfg.focus * 60;
  let remaining = focusTotal, total = focusTotal;
  if (pomo.phase === 'focus') remaining = focusTotal - Math.max(0, sessionSeconds() - (pomo.base || 0));
  if (pomo.phase === 'break') {
    total = pomo.breakTotal || cfg.short * 60;
    remaining = Math.max(0, Math.ceil(((pomo.breakEndsAt || 0) - Date.now()) / 1000));
  }
  remaining = Math.max(0, remaining);
  return {
    enabled: pomo.enabled,
    phase: pomo.enabled ? pomo.phase : 'idle',
    remaining,
    total,
    elapsed: total - remaining,
    cycle: pomo.cycle || 0,
    every: cfg.every,
    breakKind: pomo.breakKind || 'short',
    todayCount: todayLog(),
    cfg: { ...cfg },
  };
}

/** Subscribe to pomodoro / timer state (called every second while active and on changes). */
export function onPomodoro(fn) {
  pomoSubs.add(fn);
  return () => pomoSubs.delete(fn);
}
function emitPomo() {
  if (!pomoSubs.size) return;
  const snap = pomodoro();
  pomoSubs.forEach((fn) => { try { fn(snap); } catch (e) { console.error(e); } });
}

/** End the current focus phase now (skip) — goes to a break. */
export async function skipFocus() {
  if (!pomo.enabled || pomo.phase !== 'focus') return;
  await completeFocus({ manual: true });
}

/** Skip the break (or start the next focus from "ready"). */
export async function startNextFocus() {
  if (!pomo.enabled) return;
  if (readPaused()) {
    await resume();
  } else {
    setPomo({ phase: 'idle', breakEndsAt: null });
    syncTicker();
  }
}

function reconcilePomodoro() {
  if (!pomo.enabled) return;
  const run = store.get().runningEntry;
  const paused = readPaused();
  if (run && pomo.phase !== 'focus') {
    // A timer was started elsewhere (another device / tab) — treat it as focus.
    const segment = Math.max(0, Math.floor((serverNow() - Date.parse(run.started_at)) / 1000));
    setPomo({ phase: 'focus', base: Math.max(0, sessionSeconds() - segment), breakEndsAt: null });
  } else if (!run && !paused && pomo.phase !== 'idle' && pomo.phase !== 'break') {
    setPomo({ phase: 'idle', base: 0, cycle: 0, breakEndsAt: null });
  }
}

function checkPhase() {
  if (!pomo.enabled || busy) return;
  if (pomo.phase === 'focus' && store.get().runningEntry) {
    const left = cfg.focus * 60 - (sessionSeconds() - (pomo.base || 0));
    if (left <= 0 && Date.now() - failedAt > 15000) completeFocus({ overrun: -left });
  } else if (pomo.phase === 'break' && (pomo.breakEndsAt || 0) <= Date.now()) {
    completeBreak();
  }
}

async function completeFocus({ overrun = 0, manual = false } = {}) {
  busy = true;
  try {
    const endAt = serverNow() - overrun * 1000;
    if (store.get().runningEntry) await closeSegment(overrun > 3 ? endAt : null);
    const cycle = (pomo.cycle || 0) + 1;
    const long = cycle % cfg.every === 0;
    const mins = long ? cfg.long : cfg.short;
    // A long sleep may already have consumed the break; checkPhase handles it.
    setPomo({ phase: 'break', cycle, breakKind: long ? 'long' : 'short', breakTotal: mins * 60, breakEndsAt: (manual ? Date.now() : endAt - skew) + mins * 60000 });
    if (!manual) bumpLog();
    if (!manual) {
      chime('focus');
      notify('Hết phiên tập trung', long ? `Bạn đã xong ${cycle} phiên. Nghỉ dài ${mins} phút nhé.` : `Nghỉ ${mins} phút rồi quay lại.`);
      toast(long ? `Xong ${cycle} phiên tập trung — nghỉ dài ${mins} phút.` : `Hết phiên tập trung. Nghỉ ${mins} phút nhé.`, { type: 'info', duration: 6000 });
    }
  } catch (err) {
    failedAt = Date.now();
    toast.error(err);
  } finally {
    busy = false;
    syncTicker();
  }
}

function completeBreak() {
  setPomo({ phase: 'ready', breakEndsAt: null });
  chime('break');
  notify('Hết giờ nghỉ', 'Sẵn sàng cho phiên tập trung tiếp theo.');
  if (cfg.autoFocus && readPaused()) {
    toast('Hết giờ nghỉ — bắt đầu phiên tập trung mới.', { type: 'info' });
    resume().catch((err) => toast.error(err));
  } else {
    toast('Hết giờ nghỉ. Sẵn sàng tập trung tiếp?', {
      type: 'info',
      duration: 10000,
      action: { label: 'Bắt đầu phiên mới', onClick: () => startNextFocus().catch((err) => toast.error(err)) },
    });
  }
  syncTicker();
}

/* ---------- Sound (WebAudio, no assets) ---------- */
let audio = null;
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}

/** Soft bell: sine partials with a slow exponential decay. kind: 'focus' | 'break' */
export function chime(kind = 'focus', { force = false } = {}) {
  if (!cfg.sound && !force) return;
  unlockAudio();
  if (!audio) return;
  const notes = kind === 'break' ? [783.99, 1046.5] : [1046.5, 783.99, 659.25];
  const t0 = audio.currentTime + 0.03;
  notes.forEach((f, i) => {
    const t = t0 + i * 0.26;
    [[f, 0.16], [f * 2.01, 0.035], [f * 3.02, 0.012]].forEach(([freq, peak]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 1.9);
    });
  });
}

/* ---------- Notifications ---------- */
export function notifyPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}
export async function requestNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') return await Notification.requestPermission();
  } catch {}
  return notifyPermission();
}
function notify(title, body) {
  if (!cfg.notify || notifyPermission() !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: 'nm-pomodoro', silent: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* mobile browsers need a service worker — the toast + chime still fire */ }
}

/* ---------- Document title ---------- */
const TITLE_RE = /^\[[^\]]*\]\s/;
const mmss = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
};
export { mmss as formatCountdown };

function updateTitle() {
  if (typeof document === 'undefined') return;
  const base = document.title.replace(TITLE_RE, '');
  const run = store.get().runningEntry;
  let prefix = '';
  const pm = pomodoro();
  if (pm.enabled && pm.phase === 'break') prefix = `[${mmss(pm.remaining)} nghỉ] `;
  else if (run && pm.enabled && pm.phase === 'focus') prefix = `[${mmss(pm.remaining)} tập trung] `;
  else if (run) prefix = `[${mmss(sessionSeconds())}] `;
  const next = prefix + base;
  if (next !== document.title) document.title = next;
}

if (typeof document !== 'undefined') {
  // Background tabs throttle timers: catch up as soon as the tab is visible again.
  // Also re-read the running segment (it may have been stopped/started on another device).
  let lastSync = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    tick();
    if (store.get().session && Date.now() - lastSync > 30000) {
      lastSync = Date.now();
      const before = store.get().runningEntry?.id || null;
      refreshRunning().then((now) => {
        if ((now?.id || null) !== before) tickers.forEach((fn) => fn());
      }).catch(() => {});
    }
  });
}
