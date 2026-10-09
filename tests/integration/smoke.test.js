import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { newUser, deleteUser, anonClient } from './env.js';
import * as tasks from '../../src/services/tasks.js';
import * as categories from '../../src/services/categories.js';

let A;
beforeAll(async () => { A = await newUser({ displayName: 'Smoke' }); setClient(A.client); });
afterAll(async () => { await deleteUser(A?.user); });

describe('integration smoke (real PostgREST + Auth)', () => {
  it('default categories exist and a task round-trips with embedded category', async () => {
    const cats = await categories.listCategories('task');
    expect(cats.length).toBe(5);
    const t = await tasks.createTask({ title: 'Smoke task', category_id: cats[0].id, priority: 'high' });
    const list = await tasks.listTasks({});
    expect(list.find((x) => x.id === t.id)?.category?.id).toBe(cats[0].id);
  });

  it('anon key without login sees nothing', async () => {
    const { data, error } = await anonClient().from('tasks').select('id');
    expect(error || data.length === 0).toBeTruthy();
  });
});
