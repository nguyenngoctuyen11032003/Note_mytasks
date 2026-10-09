// Regression tests for the service-layer audit (pagination past max_rows, DST,
// number parsing, error mapping, null filters, backup error handling, shopping).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import { toAppError, vNumber, MESSAGES } from '../../src/services/errors.js';
import {
  configureDates, getTimezone, dayStartInstant, dayEndInstant, fromLocalInput, toLocalInput, today, addDays,
} from '../../src/utils/date.js';
import * as timer from '../../src/services/timer.js';
import * as timeEntries from '../../src/services/timeEntries.js';
import * as notes from '../../src/services/notes.js';
import * as expenses from '../../src/services/expenses.js';
import * as shopping from '../../src/services/shopping.js';
import * as backup from '../../src/services/backup.js';

let fake;
const TZ0 = getTimezone();
beforeEach(() => {
  fake = h.client = createFakeSupabase();
});
afterEach(() => {
  configureDates({ timezone: TZ0 });
  vi.useRealTimers();
});

/** Response fn that serves `total` rows, honouring the last range(a, b) like PostgREST (max_rows 1000). */
const paged = (total, make = (i) => ({ id: `r${i}` })) => (call) => {
  const r = call.chain.filter((c) => c.method === 'range').at(-1)?.args;
  const from = r ? r[0] : 0;
  const to = r ? Math.min(r[1], from + 999) : 999;
  const rows = [];
  for (let i = from; i <= to && i < total; i++) rows.push(make(i));
  return { data: rows };
};
const serve = (key, total, make) => {
  for (let i = 0; i < 30; i++) fake.respond(key, paged(total, make));
};

// --------------------------------------------------------------------------
describe('vNumber: strict decimal strings', () => {
  const ok = (v, o) => vNumber(v, 'n', o);
  const bad = (v, o) => expect(() => vNumber(v, 'n', o)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  it('accepts plain decimals and exponents', () => {
    expect(ok(' 12 ')).toBe(12);
    expect(ok('-1.5')).toBe(-1.5);
    expect(ok('+3')).toBe(3);
    expect(ok('.5')).toBe(0.5);
    expect(ok('1e3')).toBe(1000);
    expect(ok('2.5E-1')).toBe(0.25);
    expect(ok('0.500')).toBe(0.5);
    expect(ok(7)).toBe(7);
  });
  it('rejects hex/binary/dangling exponent/arrays/booleans', () => {
    for (const v of ['0x10', '0b11', '0o7', '1e', 'abc', '1,5', '1 000', 'Infinity', [5], ['1'], true, {}]) bad(v);
  });
  it('rejects Vietnamese thousands grouping instead of silently reading 1.000 as 1', () => {
    for (const v of ['1.000', '12.500', '1.000.000', '-2.000']) bad(v);
  });
});

describe('toAppError: AuthRetryableFetchError', () => {
  it('status 0/undefined → network', () => {
    expect(toAppError({ name: 'AuthRetryableFetchError', message: '{}' }).code).toBe('network');
    expect(toAppError({ name: 'AuthRetryableFetchError', message: 'x', status: 0 }).code).toBe('network');
  });
  it('5xx → server_error with a Vietnamese message', () => {
    const e = toAppError({ name: 'AuthRetryableFetchError', message: 'Bad Gateway', status: 502 });
    expect(e.code).toBe('server_error');
    expect(e.message).toBe(MESSAGES.server_error);
    expect(MESSAGES.server_error).toBe('Máy chủ đang gặp sự cố, vui lòng thử lại sau.');
  });
});

// --------------------------------------------------------------------------
describe('date.js: DST-correct day bounds', () => {
  const local = (tz, d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(d).replace(', ', 'T');

  it('Australia/Sydney: DST end (04-05) and start (10-04) begin at local midnight', () => {
    configureDates({ timezone: 'Australia/Sydney' });
    expect(dayStartInstant('2026-04-05').toISOString()).toBe('2026-04-04T13:00:00.000Z'); // +11
    expect(dayEndInstant('2026-04-05').toISOString()).toBe('2026-04-05T14:00:00.000Z'); // 04-06 00:00 +10
    expect(dayStartInstant('2026-10-04').toISOString()).toBe('2026-10-03T14:00:00.000Z'); // +10
    expect(dayEndInstant('2026-10-04').toISOString()).toBe('2026-10-04T13:00:00.000Z'); // +11
    expect(local('Australia/Sydney', dayStartInstant('2026-04-05'))).toBe('2026-04-05T00:00');
  });
  it('America/Santiago: midnight skipped → day starts at 01:00', () => {
    configureDates({ timezone: 'America/Santiago' });
    expect(local('America/Santiago', dayStartInstant('2026-09-06'))).toBe('2026-09-06T01:00');
  });
  it('America/New_York: fromLocalInput uses the offset of the target wall time', () => {
    configureDates({ timezone: 'America/New_York' });
    expect(dayStartInstant('2026-03-08').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(fromLocalInput('2026-03-08T08:00').toISOString()).toBe('2026-03-08T12:00:00.000Z'); // EDT
    expect(fromLocalInput('2026-03-08T01:30').toISOString()).toBe('2026-03-08T06:30:00.000Z'); // EST
    // ambiguous 01:30 on fall-back day → first occurrence (EDT)
    expect(fromLocalInput('2026-11-01T01:30').toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(fromLocalInput('2026-11-01T03:00').toISOString()).toBe('2026-11-01T08:00:00.000Z'); // EST
    expect(toLocalInput(fromLocalInput('2026-07-01T23:59'))).toBe('2026-07-01T23:59');
  });
  it('Asia/Ho_Chi_Minh unchanged', () => {
    configureDates({ timezone: 'Asia/Ho_Chi_Minh' });
    expect(dayStartInstant('2026-10-01').toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(fromLocalInput('2026-10-01T08:15').toISOString()).toBe('2026-10-01T01:15:00.000Z');
  });
});

// --------------------------------------------------------------------------
describe('pagination past PostgREST max_rows (1000)', () => {
  it('timer.listEntries honours limit 2500 with stable id tiebreak', async () => {
    serve('time_entries', 3000);
    const rows = await timer.listEntries({ limit: 2500 });
    expect(rows).toHaveLength(2500);
    const c = fake.last('from', 'time_entries');
    expect(fake.argsOf(c, 'order')).toEqual([['started_at', { ascending: false }], ['id', { ascending: true }]]);
  });
  it('timeEntries.listEntries / listEntriesForTask page past 1000', async () => {
    serve('time_entries', 1500);
    expect(await timeEntries.listEntries('2026-01-01T00:00:00Z', '2026-12-01T00:00:00Z')).toHaveLength(1500);
    serve('time_entries', 1700);
    expect(await timeEntries.listEntriesForTask('t1')).toHaveLength(1700);
  });
  it('notes.listNotes honours a limit above 1000', async () => {
    serve('notes', 3000);
    expect(await notes.listNotes({ limit: 1800 })).toHaveLength(1800);
  });
  it('listNotebooks / listNoteTags / noteOverview count every note', async () => {
    serve('notes', 2300, (i) => ({ id: `n${i}`, notebook: 'A', tags: ['x'], pinned: false, archived: false, kind: 'note', trashed_at: null }));
    expect(await notes.listNotebooks()).toEqual([{ name: 'A', count: 2300 }]);
    serve('notes', 2300, (i) => ({ id: `n${i}`, tags: ['x'] }));
    expect(await notes.listNoteTags()).toEqual([{ tag: 'x', count: 2300 }]);
    serve('notes', 12000, (i) => ({ id: `n${i}`, notebook: 'A', tags: [], pinned: false, archived: false, kind: 'note', trashed_at: null }));
    const o = await notes.noteOverview();
    expect(o.counts.all).toBe(12000);
    expect(o.notebooks).toEqual([{ name: 'A', count: 12000 }]);
  });
});

// --------------------------------------------------------------------------
describe('null filter objects are treated as {}', () => {
  it.each([
    ['expenses.listExpenses', () => expenses.listExpenses(null)],
    ['expenses.listRecent', () => expenses.listRecent(null)],
    ['notes.listNotes', () => notes.listNotes(null)],
    ['shopping.listItems', () => shopping.listItems(null)],
    ['timer.listEntries', () => timer.listEntries(null)],
    ['timeEntries.listEntries', () => timeEntries.listEntries('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', null)],
  ])('%s(null)', async (_n, fn) => {
    await expect(fn()).resolves.toEqual([]);
  });
});

describe('expenses.listRecent cutoff uses the user timezone', () => {
  it('cutoff = today(user tz) - days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T20:00:00Z')); // 2026-10-09 03:00 in Ho Chi Minh
    configureDates({ timezone: 'Asia/Ho_Chi_Minh' });
    await expenses.listRecent({ days: 1 });
    expect(today()).toBe('2026-10-09');
    expect(fake.argsOf(fake.last('from', 'expenses'), 'gte')).toEqual([['spent_on', addDays('2026-10-09', -1)]]);
  });
});

// --------------------------------------------------------------------------
describe('backup.exportAll: optional tables', () => {
  const emptyAll = () => { for (const t of backup.BACKUP_TABLES) fake.respond(t.table, { data: [] }); };
  it('skips an optional table only when it is missing', async () => {
    const opt = backup.BACKUP_TABLES.find((t) => t.optional);
    fake.respond(opt.table, { error: { code: 'PGRST205', message: "Could not find the table 'public.notes'" } });
    emptyAll();
    const r = await backup.exportAll();
    expect(r.missing).toEqual([opt.table]);
  });
  it('rethrows network / 5xx errors on optional tables', async () => {
    const opt = backup.BACKUP_TABLES.find((t) => t.optional);
    fake.respond(opt.table, { throws: new TypeError('Failed to fetch') });
    emptyAll();
    await expect(backup.exportAll()).rejects.toMatchObject({ code: 'network' });
    fake.reset();
    fake.respond(opt.table, { error: { code: 'XX000', message: 'internal error' } });
    emptyAll();
    await expect(backup.exportAll()).rejects.toMatchObject({ code: 'unknown' });
  });
  it('accepts a null options object', async () => {
    emptyAll();
    await expect(backup.exportAll(null)).resolves.toMatchObject({ missing: [] });
  });
});

// --------------------------------------------------------------------------
describe('timer.updateEntry validation', () => {
  it('rejects ended_at: null (cannot reopen an entry)', async () => {
    await expect(timer.updateEntry('e1', { ended_at: null })).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'ended_at' } });
    await expect(timer.updateEntry('e1', { ended_at: '' })).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'ended_at' } });
  });
  it('rejects a future end and > 24h when both ends are given', async () => {
    const s = new Date(Date.now() - 3600_000).toISOString();
    await expect(timer.updateEntry('e1', { started_at: s, ended_at: new Date(Date.now() + 3600_000).toISOString() }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { field: 'ended_at' } });
    await expect(timer.updateEntry('e1', { started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-02T00:00:01Z' }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { field: 'ended_at' } });
  });
  it('uses the update_time_entry RPC when present, then clears null fields', async () => {
    fake.respond('rpc:update_time_entry', { data: { id: 'e1' } });
    fake.respond('time_entries', { data: { id: 'e1', duration_seconds: '60', task: null } });
    const s = '2026-01-01T00:00:00.000Z';
    const e = '2026-01-01T00:01:00.000Z';
    const row = await timer.updateEntry('e1', { started_at: s, ended_at: e, task_id: null, description: null });
    expect(fake.last('rpc', 'update_time_entry').args[0]).toEqual({ p_id: 'e1', p_task_id: null, p_started_at: s, p_ended_at: e, p_description: null });
    expect(fake.argsOf(fake.last('from', 'time_entries'), 'update')[0][0]).toEqual({ task_id: null, description: null });
    expect(row.duration_seconds).toBe(60);
  });
  it('fallback (RPC missing): overlap with another entry → time_overlap', async () => {
    fake.respond('rpc:update_time_entry', { error: { code: 'PGRST202', message: 'Could not find the function' } });
    fake.respond('time_entries', { data: { id: 'e1', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T01:00:00Z' } }); // current
    fake.respond('time_entries', { data: [{ id: 'e2' }] }); // overlap probe
    await expect(timer.updateEntry('e1', { ended_at: '2026-01-01T02:00:00Z' })).rejects.toMatchObject({ code: 'time_overlap' });
    const probe = fake.last('from', 'time_entries');
    expect(fake.argsOf(probe, 'neq')).toEqual([['id', 'e1']]);
    expect(fake.argsOf(probe, 'lt')).toEqual([['started_at', '2026-01-01T02:00:00.000Z']]);
    expect(fake.argsOf(probe, 'or')).toEqual([['ended_at.is.null,ended_at.gt.2026-01-01T00:00:00.000Z']]);
  });
  it('fallback: missing entry → not_found; end before stored start → invalid_input', async () => {
    fake.respond('rpc:update_time_entry', { error: { code: 'PGRST202', message: 'x' } }, { error: { code: 'PGRST202', message: 'x' } });
    fake.respond('time_entries', { data: null });
    await expect(timer.updateEntry('e1', { ended_at: '2026-01-01T02:00:00Z' })).rejects.toMatchObject({ code: 'not_found' });
    fake.respond('time_entries', { data: { id: 'e1', started_at: '2026-01-01T03:00:00Z', ended_at: '2026-01-01T04:00:00Z' } });
    await expect(timer.updateEntry('e1', { ended_at: '2026-01-01T02:00:00Z' })).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'ended_at' } });
  });
});

// --------------------------------------------------------------------------
describe('shopping: purchaseWithPrice / revertPurchase', () => {
  const ITEM = { id: 'i1', total_price: 0, quantity: 3, unit_price: 0, expense_id: null, category_id: null, status: 'planned' };
  it('expense amount equals the actual price paid (no actual/qty rounding)', async () => {
    fake.respond('rpc:purchase_shopping_item', { data: { ...ITEM, unit_price: 33.33, total_price: 99.99, expense_id: 'x1', status: 'purchased' } });
    await shopping.purchaseWithPrice(ITEM, { actualTotal: 100 });
    const exp = fake.last('from', 'expenses');
    expect(fake.argsOf(exp, 'update')[0][0]).toEqual({ amount: 100 });
    expect(fake.argsOf(exp, 'eq')).toEqual([['id', 'x1']]);
  });
  it('id string: fetches the item first (uses its planned price)', async () => {
    fake.respond('shopping_items', { data: { ...ITEM, unit_price: 50, total_price: 150 } });
    fake.respond('rpc:purchase_shopping_item', { data: { ...ITEM, unit_price: 50, total_price: 150, expense_id: 'x1', status: 'purchased' } });
    await shopping.purchaseWithPrice('i1', { actualTotal: 150 });
    // planned already 150 → no unit_price rewrite and no expense correction
    expect(fake.calls.filter((c) => c.name === 'shopping_items' && fake.argsOf(c, 'update').length)).toHaveLength(0);
    expect(fake.last('from', 'expenses')).toBeUndefined();
  });
  it('re-purchase with an existing expense_id does not create a second expense', async () => {
    const item = { ...ITEM, total_price: 150, unit_price: 50, expense_id: 'old' };
    fake.respond('rpc:purchase_shopping_item', { data: { ...item, status: 'purchased' } });
    await shopping.purchaseWithPrice(item, { actualTotal: 120 });
    expect(fake.last('rpc', 'purchase_shopping_item').args[0].p_create_expense).toBe(false);
    const exp = fake.last('from', 'expenses');
    expect(fake.argsOf(exp, 'update')[0][0]).toEqual({ amount: 120 });
    expect(fake.argsOf(exp, 'eq')).toEqual([['id', 'old']]);
  });
  it('revertPurchase(idString, {removeExpense}) looks up the linked expense and deletes it', async () => {
    fake.respond('shopping_items', { data: { id: 'i1', expense_id: 'x9' } });
    fake.respond('shopping_items', { data: { id: 'i1', status: 'planned' } });
    await shopping.revertPurchase('i1', { removeExpense: true });
    const exp = fake.last('from', 'expenses');
    expect(fake.methods(exp)).toContain('delete');
    expect(fake.argsOf(exp, 'eq')).toEqual([['id', 'x9']]);
  });
});
