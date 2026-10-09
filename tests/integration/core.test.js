// Categories, profile, activity, auth (+ RLS) against the REAL local Supabase stack.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, anonClient, admin } from './env.js';
import { AppError } from '../../src/services/errors.js';
import * as tasks from '../../src/services/tasks.js';
import * as categories from '../../src/services/categories.js';
import * as profile from '../../src/services/profile.js';
import * as activity from '../../src/services/activity.js';
import * as auth from '../../src/services/auth.js';

const users = [];
async function user(opts) {
  const u = await newUser(opts);
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
  if (field !== undefined) expect(err.details.field).toBe(field);
  return err;
}

describe('categories service', () => {
  it('list / create / update / duplicate / delete / reorder', async () => {
    await user();
    const all = await categories.listCategories();
    expect(all).toHaveLength(14);
    const taskCats = await categories.listCategories('task');
    expect(taskCats.map((c) => c.sort_order)).toEqual([10, 20, 30, 40, 50]);
    expect(taskCats.every((c) => c.is_default)).toBe(true);
    await expectAppError(categories.listCategories('other'), 'invalid_input', 'kind');

    const c = await categories.createCategory({ kind: 'task', name: '  Dự án X ', color: '#112233', user_id: 'x', is_default: true });
    expect(c).toMatchObject({ kind: 'task', name: 'Dự án X', color: '#112233', sort_order: 100, is_default: false });
    await expectAppError(categories.createCategory({ kind: 'task', name: 'dự án x' }), 'duplicate');
    // same name, other kind is fine
    const ce = await categories.createCategory({ kind: 'expense', name: 'Dự án X' });
    expect(ce.kind).toBe('expense');
    await expectAppError(categories.createCategory({ kind: 'task', name: '' }), 'invalid_input', 'name');
    await expectAppError(categories.createCategory({ kind: 'task', name: 'ok', color: 'red' }), 'invalid_input', 'color');
    await expectAppError(categories.createCategory({ name: 'ok' }), 'invalid_input', 'kind');

    const up = await categories.updateCategory(c.id, { name: 'Dự án Y', color: null, kind: 'expense' });
    expect(up).toMatchObject({ name: 'Dự án Y', color: null, kind: 'task' }); // kind not writable on update
    await expectAppError(categories.updateCategory(c.id, { name: taskCats[0].name.toUpperCase() }), 'duplicate');
    await expectAppError(categories.updateCategory(c.id, {}), 'invalid_input', null);

    // reorder
    const ids = [c.id, ...taskCats.map((x) => x.id)].reverse();
    expect(await categories.reorder(ids)).toBe(true);
    const re = await categories.listCategories('task');
    expect(re.map((x) => x.id)).toEqual(ids);
    expect(re.map((x) => x.sort_order)).toEqual([10, 20, 30, 40, 50, 60]);
    await expectAppError(categories.reorder([]), 'invalid_input', 'ids');
    await expectAppError(categories.reorder([c.id, c.id]), 'invalid_input', 'ids');

    // delete: a task using the category degrades to category NULL
    const t = await tasks.createTask({ title: 'cat', category_id: c.id });
    const del = await categories.deleteCategory(c.id);
    expect(del).toEqual({ id: c.id, wasDefault: false, warning: null });
    expect((await tasks.getTask(t.id)).category_id).toBeNull();
    const delDef = await categories.remove(taskCats[0].id);
    expect(delDef.wasDefault).toBe(true);
    expect(delDef.warning).toContain(taskCats[0].name);
    await expectAppError(categories.deleteCategory(c.id), 'not_found');
  });

  it('RLS: B cannot see / update / delete / reorder A\'s categories', async () => {
    const A = await user();
    const aCats = await categories.listCategories('task');
    await user();
    const bCats = await categories.listCategories('task');
    expect(bCats.map((c) => c.id)).not.toContain(aCats[0].id);
    await expectAppError(categories.updateCategory(aCats[0].id, { name: 'hack' }), 'not_found');
    await expectAppError(categories.deleteCategory(aCats[0].id), 'not_found');
    await categories.reorder([aCats[0].id]); // 0 rows affected
    setClient(A.client);
    const still = await categories.listCategories('task');
    expect(still[0]).toMatchObject({ id: aCats[0].id, name: aCats[0].name, sort_order: 10 });
  });
});

describe('profile service', () => {
  it('get / update incl. validation, both call forms', async () => {
    const A = await user({ displayName: 'Người A' });
    const p = await profile.get();
    expect(p).toMatchObject({ id: A.user.id, display_name: 'Người A', timezone: 'Asia/Ho_Chi_Minh' });
    expect((await profile.getProfile()).id).toBe(A.user.id);
    expect((await profile.getProfile(A.user.id)).id).toBe(A.user.id);

    const u = await profile.update({ display_name: ' Tên mới ', currency: 'usd', timezone: 'Europe/Paris', week_starts_on: 0, theme: 'dark', id: 'x' });
    expect(u).toMatchObject({ id: A.user.id, display_name: 'Tên mới', currency: 'USD', timezone: 'Europe/Paris', week_starts_on: 0, theme: 'dark' });
    const u2 = await profile.updateProfile(A.user.id, { locale: 'en-us' });
    expect(u2.locale).toBe('en-US');
    const u3 = await profile.updateProfile({ theme: 'light' });
    expect(u3.theme).toBe('light');

    await expectAppError(profile.update({ timezone: 'Mars/Olympus' }), 'invalid_input', 'timezone');
    await expectAppError(profile.update({ currency: 'dong' }), 'invalid_input', 'currency');
    await expectAppError(profile.update({ week_starts_on: 7 }), 'invalid_input', 'week_starts_on');
    await expectAppError(profile.update({ theme: 'neon' }), 'invalid_input', 'theme');
    await expectAppError(profile.update({ avatar_url: 'ftp://x' }), 'invalid_input', 'avatar_url');
    await expectAppError(profile.update({}), 'invalid_input', null);
    expect((await profile.get()).timezone).toBe('Europe/Paris');
  });

  it('DB rejects an unknown timezone too (mapped invalid_input)', async () => {
    const A = await user();
    // bypass the client-side check: raw PostgREST call through the user's client
    const { error } = await A.client.from('profiles').update({ timezone: 'Mars/Olympus' }).eq('id', A.user.id);
    const { toAppError } = await import('../../src/services/errors.js');
    expect(toAppError(error).code).toBe('invalid_input');
  });

  it('RLS: B cannot read or update A\'s profile', async () => {
    const A = await user({ displayName: 'AAA' });
    await user();
    expect(await profile.getProfile(A.user.id)).toBeNull();
    // updateProfile(userId, patch) ignores the id → updates B only
    const r = await profile.updateProfile(A.user.id, { display_name: 'hacked' });
    expect(r.id).not.toBe(A.user.id);
    const { data } = await admin.from('profiles').select('display_name').eq('id', A.user.id).single();
    expect(data.display_name).toBe('AAA');
  });
});

describe('activity service', () => {
  it('recent shows created/completed tasks; clear empties the feed', async () => {
    await user();
    expect(await activity.recent()).toEqual([]);
    const t = await tasks.createTask({ title: 'Hoạt động' });
    await tasks.updateTask(t.id, { description: 'no log' });
    await tasks.setTaskStatus(t.id, 'completed');
    const feed = await activity.recent(10);
    expect(feed.map((r) => r.action).sort()).toEqual(['completed', 'created']);
    expect(feed.every((r) => r.entity_type === 'task' && r.entity_id === t.id && r.title === 'Hoạt động')).toBe(true);
    expect(feed[0].metadata).toEqual({});
    expect(await activity.recent(1)).toHaveLength(1);
    await expectAppError(activity.recent(0), 'invalid_input', 'limit');
    expect(await activity.clear()).toBe(true);
    expect(await activity.recentActivity()).toEqual([]);
  });

  it('RLS: B sees none of A\'s feed and clear() does not touch it', async () => {
    const A = await user();
    await tasks.createTask({ title: 'A act' });
    await user();
    expect(await activity.recent()).toEqual([]);
    await activity.clear();
    setClient(A.client);
    expect(await activity.recent()).toHaveLength(1);
  });
});

describe('auth service', () => {
  it('signIn wrong password → invalid_credentials; ok → session; signOut', async () => {
    const A = await user();
    const c = anonClient();
    setClient(c);
    expect(await auth.getSession()).toBeNull();
    const err = await expectAppError(auth.signIn(A.email, 'wrong-password'), 'invalid_credentials');
    expect(err.message).toBe('Email hoặc mật khẩu không đúng.');
    await expectAppError(auth.signIn('nobody-' + A.email, 'x'), 'invalid_credentials');
    await expectAppError(auth.signIn('not-an-email', 'x'), 'invalid_input', 'email');
    await expectAppError(auth.signIn(A.email, ''), 'invalid_input', 'password');

    const data = await auth.signIn(`  ${A.email.toUpperCase()} `, A.password);
    expect(data.user.id).toBe(A.user.id);
    const s = await auth.getSession();
    expect(s.user.id).toBe(A.user.id);
    // the services now act as A
    expect((await profile.get()).id).toBe(A.user.id);
    expect(await auth.verifyPassword(A.email, A.password)).toBeTruthy();

    await auth.signOut();
    expect(await auth.getSession()).toBeNull();
    await expectAppError(profile.get(), 'session_expired');
    // signOut again with no session does not throw
    await auth.signOut();
  });

  it('signUp an existing e-mail is rejected', async () => {
    const A = await user();
    setClient(anonClient());
    await expectAppError(auth.signUp(A.email, 'Another-pass-1'), 'user_already_exists');
    await expectAppError(auth.signUp('x@y.zz', '123'), 'invalid_input', 'password');
  });
});
