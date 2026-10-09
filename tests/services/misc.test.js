import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));
vi.stubGlobal('window', { location: { href: 'https://x.github.io/repo/#/tasks' } });

import * as kpis from '../../src/services/kpis.js';
import * as auth from '../../src/services/auth.js';
import * as profile from '../../src/services/profile.js';
import * as categories from '../../src/services/categories.js';
import * as activity from '../../src/services/activity.js';
import * as dashboard from '../../src/services/dashboard.js';
import * as index from '../../src/services/index.js';

let fake;
beforeEach(() => {
  fake = h.client = createFakeSupabase();
});
const session = { data: { session: { user: { id: 'u1' } } } };

describe('kpis', () => {
  it('list reads the kpi_progress view and normalises numbers', async () => {
    fake.respond('kpi_progress', { data: [{ id: 'k', target_value: '100.00', current_value: '40.5', progress_percent: '40.5', record_count: '3', days_left: 10 }] });
    const [k] = await kpis.listKpis();
    expect(fake.last('from').name).toBe('kpi_progress');
    expect(k).toMatchObject({ target_value: 100, current_value: 40.5, progress_percent: 40.5, record_count: 3 });
  });

  it('create never sends current_value; validates target and dates', async () => {
    await kpis.createKpi({ name: 'Đọc sách', target_value: '12', unit: '', current_value: 5, user_id: 'x', start_date: '2026-01-01' });
    const row = fake.argsOf(fake.last('from', 'kpis'), 'insert')[0][0];
    expect(row).toEqual({ name: 'Đọc sách', target_value: 12, unit: '', start_date: '2026-01-01' });
  });

  it.each([
    [{ name: 'a', target_value: 0 }, 'target_value'],
    [{ name: 'a', target_value: -3 }, 'target_value'],
    [{ name: '', target_value: 1 }, 'name'],
    [{ name: 'a', target_value: 1, start_date: '2026-05-01', end_date: '2026-04-30' }, 'end_date'],
    [{ name: 'a', target_value: 1, unit: 'x'.repeat(21) }, 'unit'],
    [{ name: 'a', target_value: 1, status: 'done' }, 'status'],
  ])('create(%o) → invalid_input on %s', async (input, field) => {
    await expect(kpis.createKpi(input)).rejects.toMatchObject({ code: 'invalid_input', details: { field } });
  });

  it('update strips current_value', async () => {
    await kpis.updateKpi('k', { current_value: 1, status: 'paused' });
    expect(fake.argsOf(fake.last('from', 'kpis'), 'update')[0][0]).toEqual({ status: 'paused' });
  });

  it('addRecord accepts (kpiId, input) and ({kpi_id, ...})', async () => {
    fake.respond('kpi_records', { data: { id: 'r', value: '7.50' } }, { data: { id: 'r2', value: 8 } });
    const r = await kpis.addRecord('k1', { recorded_on: '2026-10-09', value: '7.5', user_id: 'x' });
    expect(r.value).toBe(7.5);
    expect(fake.argsOf(fake.last('from', 'kpi_records'), 'insert')[0][0]).toEqual({ kpi_id: 'k1', recorded_on: '2026-10-09', value: 7.5 });
    await kpis.addRecord({ kpi_id: 'k2', recorded_on: '2026-10-09', value: 8, note: null });
    expect(fake.argsOf(fake.last('from', 'kpi_records'), 'insert')[0][0]).toEqual({ kpi_id: 'k2', recorded_on: '2026-10-09', value: 8, note: null });
    await expect(kpis.addRecord('k1', { value: 'x' })).rejects.toMatchObject({ details: { field: 'value' } });
    await expect(kpis.addRecord({ value: 1 })).rejects.toMatchObject({ details: { field: 'kpi_id' } });
  });

  it('listRecords / listAllRecords / updateRecord / deleteRecord', async () => {
    await kpis.listRecords('k1');
    expect(fake.argsOf(fake.last('from', 'kpi_records'), 'eq')).toEqual([['kpi_id', 'k1']]);
    await kpis.listAllRecords('2026-01-01');
    const all = fake.last('from', 'kpi_records');
    expect(fake.argsOf(all, 'gte')).toEqual([['recorded_on', '2026-01-01']]);
    expect(fake.argsOf(all, 'order')[0]).toEqual(['recorded_on', { ascending: false }]); // newest first (cap drops oldest)
    await kpis.updateRecord('r', { value: 3, kpi_id: 'other' });
    expect(fake.argsOf(fake.last('from', 'kpi_records'), 'update')[0][0]).toEqual({ value: 3 });
    expect(await kpis.deleteRecord('r')).toBe(true);
  });

  it('progress → kpi_forecast(p_kpi_id)', async () => {
    fake.respond('rpc:kpi_forecast', { data: [{ kpi_id: 'k', slope_per_day: '0.5', projected_value: '120', progress_pct: '40', records: '3' }] });
    const [f] = await kpis.progress('k');
    expect(fake.last('rpc', 'kpi_forecast').args).toEqual([{ p_kpi_id: 'k' }]);
    expect(f).toMatchObject({ slope_per_day: 0.5, projected_value: 120, progress_pct: 40, records: 3 });
    await kpis.kpiForecast();
    expect(fake.last('rpc', 'kpi_forecast').args).toEqual([{ p_kpi_id: null }]);
  });

  it('kpiProgress helper', () => {
    expect(kpis.kpiProgress({ target_value: '200', current_value: '50' })).toBe(25);
    expect(kpis.kpiProgress({ target_value: 0, current_value: 5 })).toBe(0);
  });
});

describe('auth', () => {
  it('signIn trims/lowercases email and maps errors', async () => {
    fake.respond('auth:signInWithPassword', { error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 } });
    await expect(auth.signIn(' A@B.com ', 'pw')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(fake.last('auth', 'signInWithPassword').args).toEqual([{ email: 'a@b.com', password: 'pw' }]);
  });

  it('signIn validates input before calling', async () => {
    await expect(auth.signIn('', 'x')).rejects.toMatchObject({ details: { field: 'email' } });
    await expect(auth.signIn('a@b.co', '')).rejects.toMatchObject({ details: { field: 'password' } });
    expect(fake.calls).toHaveLength(0);
  });

  it('signUp sends display_name and emailRedirectTo = appBaseUrl() + ?flow=signup', async () => {
    fake.respond('auth:signUp', { data: { user: { id: 'u', identities: [{}] }, session: null } });
    await auth.signUp('a@b.co', 'secret12', '  Nam  ');
    expect(fake.last('auth', 'signUp').args[0]).toEqual({
      email: 'a@b.co', password: 'secret12', options: { data: { display_name: 'Nam' }, emailRedirectTo: 'https://x.github.io/repo/?flow=signup' },
    });
  });

  it('signUp: existing email (no identities) → user_already_exists; short password → invalid_input', async () => {
    fake.respond('auth:signUp', { data: { user: { id: 'u', identities: [] }, session: null } });
    await expect(auth.signUp('a@b.co', 'secret12', 'N')).rejects.toMatchObject({ code: 'user_already_exists' });
    await expect(auth.signUp('a@b.co', '123', 'N')).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'password' } });
  });

  it('requestPasswordReset redirects to the app base with ?flow=recovery (templates append &token_hash)', async () => {
    await auth.requestPasswordReset('a@b.co');
    expect(fake.last('auth', 'resetPasswordForEmail').args).toEqual(['a@b.co', { redirectTo: 'https://x.github.io/repo/?flow=recovery' }]);
  });

  it('verifyEmailLink spends a token_hash link via verifyOtp; bad input → link_expired', async () => {
    fake.respond('auth:verifyOtp', { data: { session: { access_token: 't' }, user: { id: 'u' } } });
    const r = await auth.verifyEmailLink('pkce_abc', 'recovery');
    expect(fake.last('auth', 'verifyOtp').args[0]).toEqual({ token_hash: 'pkce_abc', type: 'recovery' });
    expect(r.session.access_token).toBe('t');
    await expect(auth.verifyEmailLink('', 'recovery')).rejects.toMatchObject({ code: 'link_expired' });
    await expect(auth.verifyEmailLink('x', 'bogus')).rejects.toMatchObject({ code: 'link_expired' });
    fake.respond('auth:verifyOtp', { error: { code: 'otp_expired', status: 403, message: 'Email link is invalid or has expired' } });
    await expect(auth.verifyEmailLink('pkce_old', 'recovery')).rejects.toMatchObject({ code: 'link_expired' });
  });

  it('rate limit on reset → rate_limited', async () => {
    fake.respond('auth:resetPasswordForEmail', { error: { code: 'over_email_send_rate_limit', status: 429, message: 'email rate limit exceeded' } });
    await expect(auth.requestPasswordReset('a@b.co')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('updatePassword / getSession / onAuthChange / signOut', async () => {
    await auth.updatePassword('newpass1');
    expect(fake.last('auth', 'updateUser').args).toEqual([{ password: 'newpass1' }]);
    fake.respond('auth:getSession', session);
    expect(await auth.getSession()).toEqual({ user: { id: 'u1' } });
    const cb = vi.fn();
    const off = auth.onAuthChange(cb);
    fake.authCallback('SIGNED_IN', { s: 1 });
    expect(cb).toHaveBeenCalledWith('SIGNED_IN', { s: 1 });
    off();
    expect(fake.unsubscribed).toBe(true);
    fake.respond('auth:signOut', { error: { message: 'Auth session missing!' } });
    await expect(auth.signOut()).resolves.toBeUndefined();
    fake.respond('auth:signOut', { throws: new TypeError('Failed to fetch') });
    await expect(auth.signOut()).rejects.toMatchObject({ code: 'network' });
  });

  it('not_configured', async () => {
    h.client = null;
    await expect(auth.signIn('a@b.co', 'x')).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('profile', () => {
  it('get uses the session user id', async () => {
    fake.respond('auth:getSession', session);
    fake.respond('profiles', { data: { id: 'u1' } });
    expect(await profile.get()).toEqual({ id: 'u1' });
    expect(fake.argsOf(fake.last('from', 'profiles'), 'eq')).toEqual([['id', 'u1']]);
  });

  it('no session → session_expired', async () => {
    fake.respond('auth:getSession', { data: { session: null } });
    await expect(profile.get()).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('update whitelists + validates', async () => {
    fake.respond('auth:getSession', session);
    await profile.update({ display_name: ' ', currency: 'usd', timezone: 'Asia/Tokyo', week_starts_on: '0', theme: 'dark', id: 'evil', created_at: 'x' });
    expect(fake.argsOf(fake.last('from', 'profiles'), 'update')[0][0]).toEqual({ display_name: null, currency: 'USD', timezone: 'Asia/Tokyo', week_starts_on: 0, theme: 'dark' });
  });

  it.each([
    [{ timezone: 'Mars/Olympus' }, 'timezone'],
    [{ currency: 'VN' }, 'currency'],
    [{ week_starts_on: 7 }, 'week_starts_on'],
    [{ theme: 'neon' }, 'theme'],
    [{ avatar_url: 'data:image/png' }, 'avatar_url'],
    [{ display_name: 'x'.repeat(81) }, 'display_name'],
    [{ locale: 'not a locale!!' }, 'locale'],
  ])('update(%o) → invalid_input on %s', async (patch, field) => {
    await expect(profile.update(patch)).rejects.toMatchObject({ code: 'invalid_input', details: { field } });
  });

  it('compat: getProfile(userId), updateProfile(userId, patch) and updateProfile(patch)', async () => {
    await profile.getProfile('u9');
    expect(fake.argsOf(fake.last('from', 'profiles'), 'eq')).toEqual([['id', 'u9']]);
    fake.respond('auth:getSession', session, session);
    await profile.updateProfile('ignored', { theme: 'light' });
    expect(fake.argsOf(fake.last('from', 'profiles'), 'update')[0][0]).toEqual({ theme: 'light' });
    expect(fake.argsOf(fake.last('from', 'profiles'), 'eq')).toEqual([['id', 'u1']]);
    await profile.updateProfile({ theme: 'system' });
    expect(fake.argsOf(fake.last('from', 'profiles'), 'update')[0][0]).toEqual({ theme: 'system' });
  });
});

describe('categories', () => {
  it('list(kind) filters and orders', async () => {
    await categories.listCategories('expense');
    const c = fake.last('from', 'categories');
    expect(fake.argsOf(c, 'eq')).toEqual([['kind', 'expense']]);
    expect(fake.argsOf(c, 'order').map((a) => a[0])).toEqual(['kind', 'sort_order', 'name']);
    await categories.listCategories();
    expect(fake.argsOf(fake.last('from', 'categories'), 'eq')).toEqual([]);
  });

  it('create validates name/color/kind; default sort_order 100', async () => {
    await categories.createCategory({ kind: 'task', name: ' Đọc ', color: '#AbCdEf', is_default: true });
    expect(fake.argsOf(fake.last('from', 'categories'), 'insert')[0][0]).toEqual({ kind: 'task', name: 'Đọc', color: '#AbCdEf', sort_order: 100 });
    await expect(categories.createCategory({ kind: 'task', name: 'x', color: 'red' })).rejects.toMatchObject({ details: { field: 'color' } });
    await expect(categories.createCategory({ kind: 'task', name: 'x'.repeat(51) })).rejects.toMatchObject({ details: { field: 'name' } });
    await expect(categories.createCategory({ kind: 'note', name: 'x' })).rejects.toMatchObject({ details: { field: 'kind' } });
  });

  it('update never sends kind / is_default', async () => {
    await categories.updateCategory('c', { name: 'B', kind: 'expense', is_default: false });
    expect(fake.argsOf(fake.last('from', 'categories'), 'update')[0][0]).toEqual({ name: 'B' });
  });

  it('duplicate name → duplicate', async () => {
    fake.respond('categories', { error: { code: '23505', message: 'duplicate key value violates unique constraint "categories_user_kind_name_uq"' } });
    await expect(categories.createCategory({ kind: 'task', name: 'Khác' })).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('delete returns wasDefault + warning; nothing deleted → not_found', async () => {
    fake.respond('categories', { data: [{ id: 'c', name: 'Khác', is_default: true }] });
    const r = await categories.deleteCategory('c');
    expect(r.wasDefault).toBe(true);
    expect(r.warning).toMatch(/mặc định/);
    fake.respond('categories', { data: [] });
    await expect(categories.deleteCategory('c')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reorder assigns sort_order (i+1)*10 and rejects bad input', async () => {
    await categories.reorder(['a', 'b']);
    const ups = fake.calls.filter((c) => c.name === 'categories').map((c) => [fake.argsOf(c, 'update')[0][0], fake.argsOf(c, 'eq')[0]]);
    expect(ups).toEqual([[{ sort_order: 10 }, ['id', 'a']], [{ sort_order: 20 }, ['id', 'b']]]);
    await expect(categories.reorder([])).rejects.toMatchObject({ details: { field: 'ids' } });
    await expect(categories.reorder(['a', 'a'])).rejects.toMatchObject({ details: { field: 'ids' } });
  });
});

describe('activity & dashboard', () => {
  it('recent(limit) / clear()', async () => {
    fake.respond('activity_logs', { data: [{ id: 1, metadata: null }] });
    expect(await activity.recent(5)).toEqual([{ id: 1, metadata: {} }]);
    expect(fake.argsOf(fake.last('from', 'activity_logs'), 'limit')).toEqual([[5]]);
    await activity.clear();
    expect(fake.methods(fake.last('from', 'activity_logs'))).toEqual(['delete', 'gte']);
    expect(activity.recentActivity).toBe(activity.recent);
  });

  it('summary → dashboard_summary normalised', async () => {
    fake.respond('rpc:dashboard_summary', { data: { today: '2026-10-09', tasks: { open: 3 }, money: { month_spent: '1500.5', month_budget: null }, kpis: {}, streak: { current: 2 } } });
    const s = await dashboard.summary();
    expect(s.tasks.open).toBe(3);
    expect(s.tasks.overdue).toBe(0);
    expect(s.money.month_spent).toBe(1500.5);
    expect(s.money.month_budget).toBeNull();
    expect(s.streak.current).toBe(2);
  });

  it('summary falls back to get_dashboard_summary (000200)', async () => {
    fake.respond('rpc:dashboard_summary', { error: { code: 'PGRST202', message: 'nf' } });
    fake.respond('rpc:get_dashboard_summary', { data: {
      today: '2026-10-10', tasks: { open: 4, overdue: 1 }, time: { today_minutes: 30, week_minutes: 90, running: null },
      expenses: { month_total: '1000', today_total: '50', budget_total: '3100' }, kpis: { active: 2 }, shopping: { planned: 3, planned_total: '700' },
    } });
    const s = await dashboard.summary();
    expect(s.tasks).toMatchObject({ open: 4, overdue: 1 });
    expect(s.money).toEqual({ month_spent: 1000, month_budget: 3100, month_remaining: 2100, month_projected: 3100, today_spent: 50 });
    expect(s.shopping).toEqual({ planned_count: 3, planned_total: 700 });
    expect(s.kpis.active).toBe(2);
  });

  it('productivity(p_from, p_to) and streaks()', async () => {
    fake.respond('rpc:productivity_stats', { data: { completed_by_day: [{ day: 'd', count: '2' }], completion_rate: '0.5' } });
    const p = await dashboard.productivity('2026-10-01', '2026-10-07');
    expect(fake.last('rpc', 'productivity_stats').args).toEqual([{ p_from: '2026-10-01', p_to: '2026-10-07' }]);
    expect(p.completed_by_day[0].count).toBe(2);
    expect(p.completion_rate).toBe(0.5);
    fake.respond('rpc:streaks', { data: { current: 3, longest: '9', last_active_day: '2026-10-09' } });
    expect(await dashboard.streaks()).toEqual({ current: 3, longest: 9, last_active_day: '2026-10-09' });
  });

  it('index barrel exposes namespaces', () => {
    expect(typeof index.tasks.listTasks).toBe('function');
    expect(typeof index.reports.exportCsv).toBe('function');
    expect(typeof index.AppError).toBe('function');
  });
});
