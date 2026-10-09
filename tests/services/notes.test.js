import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase.js';

const h = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/core/supabase.js', () => ({
  get supabase() {
    return h.client;
  },
}));

import * as notes from '../../src/services/notes.js';

let fake;
beforeEach(() => {
  fake = h.client = createFakeSupabase();
});

describe('notes.listNotes tag filter', () => {
  it('plain tag → array value', async () => {
    await notes.listNotes({ tag: ' work ' });
    expect(fake.argsOf(fake.last('from', 'notes'), 'contains')).toContainEqual(['tags', ['work']]);
  });

  it('tags with , " { } \\ or spelled NULL are sent as a quoted array literal', async () => {
    const cases = [
      ['a,b', '{"a,b"}'],
      ['say "hi"', '{"say \\"hi\\""}'],
      ['{x}', '{"{x}"}'],
      ['back\\slash', '{"back\\\\slash"}'],
      ['null', '{"null"}'],
    ];
    for (const [tag, literal] of cases) {
      await notes.listNotes({ tag });
      expect(fake.argsOf(fake.last('from', 'notes'), 'contains')).toContainEqual(['tags', literal]);
    }
  });
});

describe('notes.validateNote', () => {
  it('whitelists columns and normalises tags', () => {
    const row = notes.validateNote({ title: 'T', content: '  x  ', tags: '#a, a, b', user_id: 'x', search: 'y' });
    expect(row).toEqual({ title: 'T', content: '  x  ', tags: ['a', 'b'], kind: 'note' });
  });
});
