// importAll robustness on the real stack: mixed column sets in one batch and notes
// coming from a newer schema (unknown columns) must import in full, not row by row
// with failures.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import { setClient } from './clientProxy.js';
import { admin, newUser, deleteUser } from './env.js';
import * as backup from '../../src/services/backup.js';

let U;
beforeAll(async () => { U = await newUser(); setClient(U.client); });
afterAll(async () => { await deleteUser(U?.user); });

describe('importAll robustness', () => {
  it('tasks batch where some rows lack tags/priority → DB defaults, no failures', async () => {
    const tasks = [
      { id: 't1', title: 'Có tag', tags: ['a'], priority: 'high', status: 'todo' },
      { id: 't2', title: 'Không tag', status: 'todo' },              // tags/priority missing
      { id: 't3', title: 'Chỉ tiêu đề' },
    ];
    const r = await backup.importAll({ app: 'note-mytasks', version: 1, tables: { tasks } });
    expect(r.failed.tasks || 0).toBe(0);
    const { data } = await admin.from('tasks').select('title, tags, priority, status').eq('user_id', U.user.id).order('title');
    expect(data).toEqual([
      { title: 'Chỉ tiêu đề', tags: [], priority: 'medium', status: 'todo' },
      { title: 'Có tag', tags: ['a'], priority: 'high', status: 'todo' },
      { title: 'Không tag', tags: [], priority: 'medium', status: 'todo' },
    ]);
  });

  it('notes with unknown (newer-schema) columns are imported, unknown columns dropped', async () => {
    const notes = [
      { id: 'n1', title: 'Ghi chú mới', content: 'nội dung', tags: ['x'], future_col: 42, search: 'ignored', user_id: 'someone-else' },
      { id: 'n2', title: 'Thứ hai', reactions: { like: 3 } },
    ];
    const r = await backup.importAll({ app: 'note-mytasks', version: 1, tables: { notes } });
    expect(r.failed.notes || 0).toBe(0);
    const { data } = await admin.from('notes').select('title, content, tags, user_id').eq('user_id', U.user.id).order('title');
    expect(data.map((n) => n.title)).toEqual(['Ghi chú mới', 'Thứ hai']);
    expect(data.every((n) => n.user_id === U.user.id)).toBe(true);
  });
});
