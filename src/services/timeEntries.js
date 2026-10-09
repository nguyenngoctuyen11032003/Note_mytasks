// Compat facade over timer.js (kept for existing imports). New code should
// import from './timer.js'. Start/stop go through the atomic RPCs
// start_timer/stop_timer (migration 000200).
import { db, run, requireId, vInstant, numify } from './errors.js';
import * as timer from './timer.js';

const COLS = 'id, task_id, description, started_at, ended_at, duration_seconds, source, created_at';
const norm = (rows) => numify(rows, ['duration_seconds']);

/** The running time_entries row (ended_at null) or null. */
export async function getRunningEntry() {
  return norm(await run(db().from('time_entries').select(COLS).is('ended_at', null).maybeSingle()));
}

/** Entries that started in [fromIso, toIso). */
export async function listEntries(fromIso, toIso, { taskId } = {}) {
  let q = db().from('time_entries').select(COLS)
    .gte('started_at', vInstant(fromIso, 'from', { required: true }))
    .lt('started_at', vInstant(toIso, 'to', { required: true }));
  if (taskId) q = q.eq('task_id', taskId);
  return norm(await run(q.order('started_at', { ascending: false }).limit(2000)));
}

export async function listEntriesForTask(taskId) {
  requireId(taskId, 'task_id');
  return norm(await run(db().from('time_entries').select(COLS).eq('task_id', taskId).order('started_at', { ascending: false })));
}

/** Start a timer segment (any running one is closed by the RPC). */
export async function startEntry({ task_id = null, description = null } = {}) {
  return timer.start(task_id, description);
}

/** Close the running segment. `entry` is accepted for compatibility (RPC closes the user's running one). */
// eslint-disable-next-line no-unused-vars
export async function stopEntry(entry) {
  return timer.stop();
}

export async function createManualEntry({ task_id = null, description = null, started_at, ended_at } = {}) {
  return timer.logTime({ taskId: task_id, startedAt: started_at, endedAt: ended_at, description });
}

export const updateEntry = timer.updateEntry;
export const deleteEntry = timer.deleteEntry;
export const entrySeconds = timer.entrySeconds;
