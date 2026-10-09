// 001200: 'avatars' bucket — public read, writes only inside avatars/<own uid>/.
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, asUser, asAnon } from './harness.js';

let db, a, b;
beforeAll(async () => {
  db = await createDb();
  a = await createUser(db);
  b = await createUser(db);
});

const insert = (tx, bucket, name) =>
  tx.query('insert into storage.objects (bucket_id, name) values ($1, $2) returning name', [bucket, name]);

describe('001200 avatars storage', () => {
  it('creates a public bucket limited to 512 KB raster images', async () => {
    const { rows } = await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars'");
    expect(rows[0]).toEqual({ public: true, file_size_limit: 524288, allowed_mime_types: ['image/webp', 'image/jpeg', 'image/png'] });
  });

  it('is idempotent', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../../supabase/migrations/20261009001200_avatars_storage.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    const { rows } = await db.query("select count(*)::int n from pg_policies where schemaname = 'storage' and policyname like 'avatars_%'");
    expect(rows[0].n).toBe(4);
  });

  it('lets a user write, read, replace and delete inside their own folder', async () => {
    await asUser(db, a, async (tx) => {
      await insert(tx, 'avatars', `${a}/avatar.webp`);
      const own = await tx.query("select name from storage.objects where bucket_id = 'avatars'");
      expect(own.rows.map((r) => r.name)).toEqual([`${a}/avatar.webp`]);
      const upd = await tx.query("update storage.objects set name = $1 where name = $2", [`${a}/avatar.jpg`, `${a}/avatar.webp`]);
      expect(upd.affectedRows).toBe(1);
      const del = await tx.query('delete from storage.objects where name = $1', [`${a}/avatar.jpg`]);
      expect(del.affectedRows).toBe(1);
    });
  });

  it("rejects writes into another user's folder, the bucket root or another bucket", async () => {
    await db.query("insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing");
    for (const [bucket, name] of [['avatars', `${b}/avatar.webp`], ['avatars', 'avatar.webp'], ['other', `${a}/x.png`]]) {
      await expect(asUser(db, a, (tx) => insert(tx, bucket, name))).rejects.toThrow(/row-level security/);
    }
  });

  it("cannot see, move or delete another user's avatar", async () => {
    await asUser(db, b, (tx) => insert(tx, 'avatars', `${b}/avatar.webp`));
    await asUser(db, a, async (tx) => {
      expect((await tx.query("select 1 from storage.objects where name like $1", [`${b}/%`])).rows).toHaveLength(0);
      expect((await tx.query('update storage.objects set name = $1 where name = $2', [`${a}/stolen.webp`, `${b}/avatar.webp`])).affectedRows).toBe(0);
      expect((await tx.query('delete from storage.objects where name = $1', [`${b}/avatar.webp`])).affectedRows).toBe(0);
    });
    const { rows } = await db.query('select owner from storage.objects where name = $1', [`${b}/avatar.webp`]);
    expect(rows).toHaveLength(1);
  });

  it('anon cannot upload', async () => {
    await expect(asAnon(db, (tx) => insert(tx, 'avatars', `${a}/avatar.webp`))).rejects.toThrow(/row-level security/);
  });
});
