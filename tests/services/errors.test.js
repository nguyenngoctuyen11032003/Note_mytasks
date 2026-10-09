import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import {
  AppError, toAppError, unwrap, run, db, rpc, rpcOr, pick, emptyToNull, likePattern, orValue, searchOr, numify, toNum,
  vText, vNumber, isDay, MESSAGES,
} from '../../src/services/errors.js';

beforeEach(() => {
  h.client = createFakeSupabase();
});

describe('AppError', () => {
  it('carries code, default Vietnamese message, cause and details', () => {
    const cause = new Error('raw');
    const e = new AppError('duplicate', undefined, { cause, details: { field: 'name' } });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('duplicate');
    expect(e.message).toBe(MESSAGES.duplicate);
    expect(e.cause).toBe(cause);
    expect(e.details.field).toBe('name');
    expect(e.sessionExpired).toBe(false);
    expect(new AppError('session_expired').sessionExpired).toBe(true);
  });
});

describe('toAppError — Postgres / PostgREST codes', () => {
  it.each([
    ['23505', 'duplicate'],
    ['23503', 'invalid_reference'],
    ['23514', 'invalid_input'],
    ['23502', 'invalid_input'],
    ['22023', 'invalid_input'],
    ['22P02', 'invalid_input'],
    ['42501', 'forbidden'],
    ['PGRST301', 'forbidden'],
    ['PGRST116', 'not_found'],
    ['P0002', 'not_found'],
    ['PGRST202', 'feature_unavailable'],
    ['42883', 'feature_unavailable'],
    ['PGRST205', 'schema_missing'],
  ])('%s → %s', (code, expected) => {
    const e = toAppError({ code, message: 'duplicate key value violates unique constraint "x_pkey"', details: 'Key (id)=(1)', hint: null });
    expect(e.code).toBe(expected);
    expect(e.message).toBe(MESSAGES[expected]);
    // raw SQL text never leaks into the user-facing message
    expect(e.message).not.toMatch(/constraint|Key \(id\)/);
  });

  it('unique violation of the one-running-timer index → timer_already_running', () => {
    const e = toAppError({ code: '23505', message: 'duplicate key value violates unique constraint "time_entries_one_running_idx"' });
    expect(e.code).toBe('timer_already_running');
  });

  it('000200 English messages under 22023/P0002 map to specific codes', () => {
    expect(toAppError({ code: '22023', message: 'cannot start a timer on a closed task' }).code).toBe('task_closed');
    expect(toAppError({ code: '22023', message: 'item is already purchased' }).code).toBe('already_purchased');
    expect(toAppError({ code: '22023', message: 'p_from must be on or before p_to' }).code).toBe('invalid_input');
    expect(toAppError({ code: 'P0002', message: 'shopping item not found' }).code).toBe('not_found');
  });

  it('PGRST301 with "JWT expired" → session_expired', () => {
    expect(toAppError({ code: 'PGRST301', message: 'JWT expired' }).code).toBe('session_expired');
  });
});

describe('toAppError — RPC business codes', () => {
  it.each(['timer_already_running', 'task_closed', 'time_overlap', 'not_found', 'already_purchased', 'invalid_input'])(
    'P0001 %s',
    (code) => {
      const e = toAppError({ code: 'P0001', message: code });
      expect(e.code).toBe(code);
      expect(e.message).toBe(MESSAGES[code]);
    },
  );
  it('not_authenticated → session_expired', () => {
    expect(toAppError({ code: 'P0001', message: 'not_authenticated' }).code).toBe('session_expired');
  });
});

describe('toAppError — Supabase Auth', () => {
  it.each([
    [{ code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 }, 'invalid_credentials'],
    [{ message: 'Invalid login credentials', status: 400 }, 'invalid_credentials'],
    [{ code: 'email_not_confirmed', message: 'Email not confirmed' }, 'email_not_confirmed'],
    [{ code: 'user_already_exists', message: 'User already registered' }, 'user_already_exists'],
    [{ message: 'User already registered' }, 'user_already_exists'],
    [{ code: 'weak_password', message: 'Password should be at least 6 characters' }, 'weak_password'],
    [{ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded', status: 429 }, 'rate_limited'],
    [{ message: 'Something', status: 429 }, 'rate_limited'],
    [{ code: 'session_expired', message: 'Session expired' }, 'session_expired'],
    [{ message: 'JWT expired' }, 'session_expired'],
    [{ message: 'Auth session missing!' }, 'session_expired'],
    [{ code: 'same_password', message: 'New password should be different from the old password.' }, 'same_password'],
    [{ code: 'flow_state_expired', message: 'x' }, 'link_expired'],
  ])('%o → %s', (err, expected) => {
    expect(toAppError(err).code).toBe(expected);
  });
});

describe('toAppError — network & unknown', () => {
  it('TypeError fetch failed → network', () => {
    expect(toAppError(new TypeError('fetch failed')).code).toBe('network');
    expect(toAppError(new TypeError('Failed to fetch')).code).toBe('network');
    expect(toAppError({ name: 'AuthRetryableFetchError', message: '{}' }).code).toBe('network');
  });
  it('unknown errors get a generic message and keep the cause', () => {
    const raw = { code: 'XX000', message: 'internal error: select * from secret', details: 'Authorization: Bearer abc' };
    const e = toAppError(raw);
    expect(e.code).toBe('unknown');
    expect(e.message).toBe(MESSAGES.unknown);
    expect(e.message).not.toMatch(/select|Bearer/);
    expect(e.cause).toBe(raw);
  });
  it('null / AppError passthrough', () => {
    expect(toAppError(null).code).toBe('unknown');
    const a = new AppError('forbidden');
    expect(toAppError(a)).toBe(a);
  });
});

describe('unwrap / run / db / rpc', () => {
  it('unwrap returns data or throws mapped error', () => {
    expect(unwrap({ data: [1], error: null })).toEqual([1]);
    expect(() => unwrap({ data: null, error: { code: '23505', message: 'x' } })).toThrow(AppError);
    try {
      unwrap({ data: null, error: { code: '23505', message: 'x' } });
    } catch (e) {
      expect(e.code).toBe('duplicate');
    }
  });
  it('run maps rejected promises', async () => {
    await expect(run(Promise.reject(new TypeError('Failed to fetch')))).rejects.toMatchObject({ code: 'network' });
  });
  it('db() throws not_configured when the client is null', () => {
    h.client = null;
    expect(() => db()).toThrow(AppError);
    try {
      db();
    } catch (e) {
      expect(e.code).toBe('not_configured');
    }
  });
  it('rpc passes args through', async () => {
    h.client.respond('rpc:x', { data: 5 });
    expect(await rpc('x', { p_a: 1 })).toBe(5);
    expect(h.client.last('rpc', 'x').args).toEqual([{ p_a: 1 }]);
  });
  it('rpcOr falls back only on missing function', async () => {
    h.client.respond('rpc:new_fn', { error: { code: 'PGRST202', message: 'Could not find the function' } });
    expect(await rpcOr('new_fn', {}, () => 'fallback')).toBe('fallback');
    h.client.respond('rpc:new_fn', { error: { code: '42501', message: 'denied' } });
    await expect(rpcOr('new_fn', {}, () => 'fallback')).rejects.toMatchObject({ code: 'forbidden' });
    h.client.respond('rpc:new_fn', { error: { code: '42883', message: 'function does not exist' } });
    await expect(rpcOr('new_fn', {})).rejects.toMatchObject({ code: 'feature_unavailable' });
  });
});

describe('helpers', () => {
  it('pick keeps only allowed defined keys', () => {
    expect(pick({ a: 1, b: undefined, c: 3, user_id: 'x' }, ['a', 'b', 'c'])).toEqual({ a: 1, c: 3 });
    expect(pick(null, ['a'])).toEqual({});
  });
  it('emptyToNull trims and nulls empty strings', () => {
    expect(emptyToNull('  ')).toBeNull();
    expect(emptyToNull(' a ')).toBe('a');
    expect(emptyToNull(undefined)).toBeNull();
    expect(emptyToNull(0)).toBe(0);
  });
  it('likePattern escapes LIKE wildcards and *', () => {
    expect(likePattern('50%_off')).toBe('%50\\%\\_off%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
    expect(likePattern('x*y')).toBe('%x_y%');
  });
  it('orValue quotes PostgREST reserved characters', () => {
    expect(orValue('a,b.(c):d')).toBe('"a,b.(c):d"');
    expect(orValue('say "hi"')).toBe('"say \\"hi\\""');
  });
  it('searchOr builds an escaped multi-column ilike', () => {
    expect(searchOr('a,b', ['title', 'note'])).toBe('title.ilike."%a,b%",note.ilike."%a,b%"');
  });
  it('numify / toNum convert numeric strings', () => {
    expect(numify([{ amount: '12.50', x: '1' }], ['amount'])).toEqual([{ amount: 12.5, x: '1' }]);
    expect(numify(null, ['a'])).toBeNull();
    expect(toNum('')).toBeNull();
    expect(toNum('abc')).toBeNull();
  });
  it('vText / vNumber / isDay', () => {
    expect(() => vText('', 'f', { required: true })).toThrow(expect.objectContaining({ code: 'invalid_input', details: { field: 'f' } }));
    expect(vNumber('  42 ', 'n')).toBe(42);
    expect(() => vNumber('1.5', 'n', { integer: true })).toThrow(AppError);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-1-01')).toBe(false);
  });
});
