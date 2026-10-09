// Service-layer audit fixes against the REAL local Supabase stack:
// paging past PostgREST max_rows (1000), null filter objects, timer.updateEntry
// validation (RPC update_time_entry and the client-side fallback), shopping
// purchaseWithPrice / revertPurchase and backup.exportAll(null).
// Works with or without migration 20261009001000 (update_time_entry + trigger).
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, admin } from './env.js';
import { AppError } from '../../src/services/errors.js';
import * as timer from '../../src/services/timer.js';
import * as timeEntries from '../../src/services/timeEntries.js';
import * as notes from '../../src/services/notes.js';
import * as expenses from '../../src/services/expenses.js';
import * as shopping from '../../src/services/shopping.js';
import * as backup from '../../src/services/backup.js';

const users = [];
async function user() {
  const u = await newUser();
  users.push(u);
  setClient(u.client);
  return u;
}
afterEach(async () => {
  while (users.length) await deleteUser(users.pop().user);
});

async function expectAppError(p, code, field) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect(err.code).toBe(code);
  if (field !== undefined) expect(err.details?.field).toBe(field);
  return err;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

/** The signed-in client, except rpc('update_time_entry') answers like a DB without the function. */
function withoutUpdateRpc(client) {
  return new Proxy(client, {
    get(t, prop) {
      if (prop === 'rpc') {
        return (name, args) => (name === 'update_time_entry'
          ? Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.update_time_entry', details: null, hint: null } })
          : t.rpc(name, args));
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// ---------------------------------------------------------------------------
describe('paging past max_rows (1000)', () => {
  it('time entries: timer.listEntries / timeEntries.listEntries / listEntriesForTask', async () => {
    const u = await user();
    const { data: task, error: te } = await admin.from('tasks').insert({ user_id: u.user.id, title: 'paging' }).select('id').single();
    expect(te).toBeNull();
    // 1100 one-minute entries, 2 minutes apart, ending ≥ 1 day ago (no overlap, nothing in the future).
    const base = Date.now() - 5 * 86400_000;
    const rows = Array.from({ length: 1100 }, (_, i) => ({
      user_id: u.user.id,
      task_id: task.id,
      started_at: new Date(base + i * 120_000).toISOString(),
      ended_at: new Date(base + i * 120_000 + 60_000).toISOString(),
      source: 'manual',
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from('time_entries').insert(rows.slice(i, i + 500));
      expect(error).toBeNull();
    }
    const from = new Date(base - 1000).toISOString();
    const to = new Date(Date.now()).toISOString();
    expect(await timeEntries.listEntries(from, to)).toHaveLength(1100);
    expect(await timeEntries.listEntries(from, to, null)).toHaveLength(1100);
    expect(await timeEntries.listEntriesForTask(task.id)).toHaveLength(1100);
    const viaTimer = await timer.listEntries({ from, to, limit: 1050 });
    expect(viaTimer).toHaveLength(1050);
    expect(new Set(viaTimer.map((r) => r.id)).size).toBe(1050);
    expect(await timer.listEntries({ from, to, limit: 5000 })).toHaveLength(1100);
  });

  it('notes: listNotes limit > 1000, listNotebooks / listNoteTags / noteOverview exact counts', async () => {
    const u = await user();
    const rows = Array.from({ length: 1150 }, (_, i) => ({
      user_id: u.user.id, title: `n${i}`, notebook: 'Sổ A', tags: ['x'], archived: i < 10, trashed_at: i >= 1140 ? new Date().toISOString() : null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from('notes').insert(rows.slice(i, i + 500));
      expect(error).toBeNull();
    }
    const live = 1150 - 10 - 10;
    const list = await notes.listNotes({ limit: 2000 });
    expect(list).toHaveLength(live);
    expect(new Set(list.map((n) => n.id)).size).toBe(live);
    expect(await notes.listNotes(null)).toHaveLength(500); // default limit
    expect(await notes.listNotebooks()).toEqual([{ name: 'Sổ A', count: live }]);
    expect(await notes.listNoteTags()).toEqual([{ tag: 'x', count: live }]);
    const o = await notes.noteOverview();
    expect(o.counts).toMatchObject({ all: live, archived: 10, trash: 10, note: live });
    expect(o.notebooks).toEqual([{ name: 'Sổ A', count: live }]);
  });
});

// ---------------------------------------------------------------------------
describe('null filter objects', () => {
  it('listExpenses / listRecent / listItems / listNotes / timer.listEntries accept null', async () => {
    await user();
    await expect(expenses.listExpenses(null)).resolves.toEqual([]);
    await expect(expenses.listRecent(null)).resolves.toEqual([]);
    await expect(shopping.listItems(null)).resolves.toEqual([]);
    await expect(notes.listNotes(null)).resolves.toEqual([]);
    await expect(timer.listEntries(null)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe.each([
  ['RPC update_time_entry (or plain update when the RPC is missing)', (c) => c],
  ['client-side fallback (RPC reported missing)', withoutUpdateRpc],
])('timer.updateEntry — %s', (_label, wrap) => {
  async function setup() {
    const u = await user();
    setClient(wrap(u.client));
    const a = await timer.logTime({ startedAt: hoursAgo(5), endedAt: hoursAgo(4), description: 'A' });
    const b = await timer.logTime({ startedAt: hoursAgo(3), endedAt: hoursAgo(2), description: 'B' });
    return { u, a, b };
  }

  it('valid edit: new span, description cleared; duration recomputed', async () => {
    const { a } = await setup();
    const s = hoursAgo(5.5);
    const e = hoursAgo(4.5);
    const r = await timer.updateEntry(a.id, { started_at: s, ended_at: e, description: null });
    expect(r.id).toBe(a.id);
    expect(Date.parse(r.started_at)).toBe(Date.parse(s));
    expect(Date.parse(r.ended_at)).toBe(Date.parse(e));
    expect(r.duration_seconds).toBe(3600);
    expect(r.description).toBeNull();
    // description-only edit
    const r2 = await timer.updateEntry(a.id, { description: 'mới' });
    expect(r2.description).toBe('mới');
    expect(r2.duration_seconds).toBe(3600);
  });

  it('overlap with another entry → time_overlap, row unchanged', async () => {
    const { a, b } = await setup();
    await expectAppError(timer.updateEntry(a.id, { ended_at: hoursAgo(2.5) }), 'time_overlap');
    await expectAppError(timer.updateEntry(b.id, { started_at: hoursAgo(4.5) }), 'time_overlap');
    const [row] = (await timer.listEntries({ from: hoursAgo(6) })).filter((x) => x.id === a.id);
    expect(Date.parse(row.ended_at)).toBe(Date.parse(a.ended_at));
  });

  it('ended_at null / future end / > 24h / end before stored start → invalid_input', async () => {
    const { a } = await setup();
    await expectAppError(timer.updateEntry(a.id, { ended_at: null }), 'invalid_input', 'ended_at');
    await expectAppError(timer.updateEntry(a.id, { ended_at: new Date(Date.now() + 3600_000).toISOString() }), 'invalid_input', 'ended_at');
    await expectAppError(timer.updateEntry(a.id, { started_at: hoursAgo(40), ended_at: hoursAgo(10) }), 'invalid_input', 'ended_at');
    const err = await expectAppError(timer.updateEntry(a.id, { ended_at: hoursAgo(6) }), 'invalid_input');
    expect(err.message).not.toMatch(/violates|constraint|check/i);
  });

  it('unknown / foreign entry → not_found', async () => {
    const { a } = await setup();
    await expectAppError(timer.updateEntry('00000000-0000-4000-8000-000000000000', { ended_at: hoursAgo(1) }), 'not_found');
    await user(); // another account cannot touch a's entry
    setClient(wrap(users.at(-1).client));
    await expectAppError(timer.updateEntry(a.id, { ended_at: hoursAgo(4.2) }), 'not_found');
  });
});

// ---------------------------------------------------------------------------
describe('shopping: purchaseWithPrice / revertPurchase', () => {
  const expensesOf = async (uid) => (await admin.from('expenses').select('id, amount').eq('user_id', uid)).data;

  it('unpriced item: expense = actual paid (no actual/qty rounding); re-purchase keeps one expense', async () => {
    const u = await user();
    const item = await shopping.createItem({ name: 'Pin AA', quantity: 3, status: 'planned' });
    const bought = await shopping.purchaseWithPrice(item.id, { actualTotal: 100 });
    expect(bought.status).toBe('purchased');
    expect(bought.expense_id).toBeTruthy();
    let ex = await expensesOf(u.user.id);
    expect(ex).toHaveLength(1);
    expect(Number(ex[0].amount)).toBe(100);

    // Revert keeping the expense, then buy again at another price: still one expense, amount updated.
    const back = await shopping.revertPurchase(item.id, { removeExpense: false });
    expect(back.status).toBe('planned');
    const again = await shopping.purchaseWithPrice(item.id, { actualTotal: 120 });
    expect(again.expense_id).toBe(bought.expense_id);
    ex = await expensesOf(u.user.id);
    expect(ex).toHaveLength(1);
    expect(Number(ex[0].amount)).toBe(120);

    // Revert by id string with removeExpense → linked expense deleted.
    await shopping.revertPurchase(item.id, { removeExpense: true });
    expect(await expensesOf(u.user.id)).toHaveLength(0);
  });

  it('priced item bought at the planned price: no correction needed', async () => {
    const u = await user();
    const item = await shopping.createItem({ name: 'Sữa', quantity: 2, unit_price: 75, status: 'planned' });
    await shopping.purchaseWithPrice(item.id, { actualTotal: 150 });
    const ex = await expensesOf(u.user.id);
    expect(ex).toHaveLength(1);
    expect(Number(ex[0].amount)).toBe(150);
  });
});

// ---------------------------------------------------------------------------
describe('backup.exportAll', () => {
  it('accepts null options', async () => {
    await user();
    const r = await backup.exportAll(null);
    expect(r.app).toBe('note-mytasks');
    expect(r.missing).toEqual([]);
    expect(r.tables.categories.length).toBeGreaterThan(0);
  });
});
