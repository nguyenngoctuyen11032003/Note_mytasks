// Timer controller shared by the topbar chip, the Time page and task rows.
// Model (see ARCHITECTURE §4.3): a session is a list of segments.
//   start  → insert segment          pause → close segment
//   resume → insert new segment       stop  → close segment, forget session
// "Paused" state lives in localStorage (it has no DB representation).
import * as store from '../core/store.js';
import { getRunningEntry, startEntry, stopEntry } from '../services/timeEntries.js';
import { getTask } from '../services/tasks.js';

const KEY = 'nm.pausedSession';
const tickers = new Set();
let interval = null;

function readPaused() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}
function writePaused(v) {
  try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {}
}

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
  syncTicker();
  return store.get().runningEntry;
}

/** Start a fresh timer. Any running one is closed first. */
export async function start({ taskId = null, description = null } = {}) {
  const cur = store.get().runningEntry;
  if (cur) await stopEntry(cur);
  const e = await startEntry({ task_id: taskId, description });
  writePaused(null);
  store.set({ runningEntry: await withTask(e) });
  syncTicker();
  return e;
}

export async function pause() {
  const cur = store.get().runningEntry;
  if (!cur) return;
  const closed = await stopEntry(cur);
  const prev = readPaused();
  const secs = (closed?.duration_seconds ?? 0) + (prev && prev.task_id === cur.task_id ? prev.seconds || 0 : 0);
  writePaused({ task_id: cur.task_id, description: cur.description, title: cur.task?.title || cur.description || '', seconds: secs, at: Date.now() });
  store.set({ runningEntry: null });
  syncTicker();
}

export async function resume() {
  const p = readPaused();
  if (!p) return;
  const e = await startEntry({ task_id: p.task_id, description: p.description });
  store.set({ runningEntry: await withTask(e) });
  syncTicker();
}

export async function stop() {
  const cur = store.get().runningEntry;
  if (cur) await stopEntry(cur);
  writePaused(null);
  store.set({ runningEntry: null });
  syncTicker();
}

export function discardPaused() {
  writePaused(null);
  tickers.forEach((fn) => fn());
}

/** Elapsed seconds of the current session (paused segments + running one). */
export function sessionSeconds() {
  const cur = store.get().runningEntry;
  const p = readPaused();
  const carried = p && cur && p.task_id === cur.task_id ? p.seconds || 0 : 0;
  if (!cur) return p?.seconds || 0;
  return carried + Math.max(0, Math.floor((Date.now() - new Date(cur.started_at).getTime()) / 1000));
}

export function onTick(fn) {
  tickers.add(fn);
  syncTicker();
  return () => { tickers.delete(fn); syncTicker(); };
}

function syncTicker() {
  const need = store.get().runningEntry && tickers.size;
  if (need && !interval) interval = setInterval(() => tickers.forEach((fn) => fn()), 1000);
  if (!need && interval) { clearInterval(interval); interval = null; }
  tickers.forEach((fn) => fn());
}

// Paused session must keep its carried seconds when resumed:
// keep the paused record while running so sessionSeconds() can add it, and
// clear it only on stop/start-new.
