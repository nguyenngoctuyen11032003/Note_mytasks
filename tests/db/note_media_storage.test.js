// 001300: private 'note-media' bucket — <uid>/<note_id>/<file>, own folder only,
// uploads only into one of the caller's own notes.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, createUser, asUser, asAnon } from './harness.js';

let db, a, b, noteA, noteA2, noteB;
const B = 'note-media';

const insert = (tx, name, bucket = B) =>
  tx.query('insert into storage.objects (bucket_id, name) values ($1, $2) returning name', [bucket, name]);
const newNote = async (uid) =>
  (await asUser(db, uid, (tx) => tx.query("insert into public.notes (user_id, title) values ($1, 'n') returning id", [uid]))).rows[0].id;

beforeAll(async () => {
  db = await createDb();
  a = await createUser(db);
  b = await createUser(db);
  noteA = await newNote(a);
  noteA2 = await newNote(a);
  noteB = await newNote(b);
});

describe('001300 note-media storage', () => {
  it('creates a private 25 MB bucket for raster images and audio', async () => {
    const { rows } = await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'note-media'");
    expect(rows[0]).toEqual({
      public: false,
      file_size_limit: 26214400,
      allowed_mime_types: ['image/webp', 'image/jpeg', 'image/png', 'image/gif',
        'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'],
    });
  });

  it('is idempotent', async () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261009001300_note_media_storage.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    const { rows } = await db.query("select count(*)::int n from pg_policies where schemaname = 'storage' and policyname like 'note_media_%'");
    expect(rows[0].n).toBe(4);
    const bk = await db.query("select count(*)::int n from storage.buckets where id = 'note-media'");
    expect(bk.rows[0].n).toBe(1);
  });

  it('lets a user upload, read, move and delete inside their own note folder', async () => {
    await asUser(db, a, async (tx) => {
      await insert(tx, `${a}/${noteA}/x.webp`);
      const own = await tx.query('select name from storage.objects where bucket_id = $1', [B]);
      expect(own.rows.map((r) => r.name)).toEqual([`${a}/${noteA}/x.webp`]);
      const upd = await tx.query('update storage.objects set name = $1 where name = $2', [`${a}/${noteA2}/x.webp`, `${a}/${noteA}/x.webp`]);
      expect(upd.affectedRows).toBe(1);
      const del = await tx.query('delete from storage.objects where name = $1', [`${a}/${noteA2}/x.webp`]);
      expect(del.affectedRows).toBe(1);
    });
  });

  it("rejects uploads into another user's folder, the bucket root, a non-note folder or another user's note", async () => {
    const bad = [
      `${b}/${noteB}/x.webp`, // other user's folder
      'x.webp', // bucket root
      `${a}/x.webp`, // no note folder
      `${a}/00000000-0000-4000-8000-000000000000/x.webp`, // note does not exist
      `${a}/${noteB}/x.webp`, // own top folder, but B's note
      `${a}/not-a-uuid/x.webp`,
    ];
    for (const name of bad) {
      await expect(asUser(db, a, (tx) => insert(tx, name))).rejects.toThrow(/row-level security/);
    }
  });

  it("cannot see, move or delete another user's media", async () => {
    await asUser(db, b, (tx) => insert(tx, `${b}/${noteB}/secret.png`));
    await asUser(db, a, async (tx) => {
      expect((await tx.query('select 1 from storage.objects where name like $1', [`${b}/%`])).rows).toHaveLength(0);
      expect((await tx.query('update storage.objects set name = $1 where name = $2', [`${a}/${noteA}/stolen.png`, `${b}/${noteB}/secret.png`])).affectedRows).toBe(0);
      expect((await tx.query('delete from storage.objects where name = $1', [`${b}/${noteB}/secret.png`])).affectedRows).toBe(0);
    });
    const { rows } = await db.query('select 1 from storage.objects where name = $1', [`${b}/${noteB}/secret.png`]);
    expect(rows).toHaveLength(1);
  });

  it("cannot move own media into someone else's folder or note", async () => {
    await asUser(db, a, (tx) => insert(tx, `${a}/${noteA}/keep.png`));
    for (const to of [`${b}/${noteB}/keep.png`, `${a}/${noteB}/keep.png`]) {
      await expect(asUser(db, a, (tx) => tx.query('update storage.objects set name = $1 where name = $2', [to, `${a}/${noteA}/keep.png`])))
        .rejects.toThrow(/row-level security/);
    }
  });

  it('media of a permanently deleted note can still be listed and removed by its owner', async () => {
    const gone = await newNote(a);
    await asUser(db, a, (tx) => insert(tx, `${a}/${gone}/old.webm`));
    await asUser(db, a, (tx) => tx.query('delete from public.notes where id = $1', [gone]));
    await asUser(db, a, async (tx) => {
      expect((await tx.query('select name from storage.objects where name like $1', [`${a}/${gone}/%`])).rows).toHaveLength(1);
      // …but nothing new can be uploaded there
      await expect(insert(tx, `${a}/${gone}/new.webm`)).rejects.toThrow(/row-level security/);
    });
    await asUser(db, a, async (tx) => {
      expect((await tx.query('delete from storage.objects where name like $1', [`${a}/${gone}/%`])).affectedRows).toBe(1);
    });
  });

  it('anon can neither read nor write', async () => {
    await expect(asAnon(db, (tx) => insert(tx, `${a}/${noteA}/x.webp`))).rejects.toThrow(/row-level security/);
    await asAnon(db, async (tx) => {
      expect((await tx.query('select 1 from storage.objects where bucket_id = $1', [B])).rows).toHaveLength(0);
      expect((await tx.query('delete from storage.objects where bucket_id = $1', [B])).affectedRows).toBe(0);
    });
  });

  it('the avatars policies do not open note-media', async () => {
    await expect(asUser(db, a, (tx) => insert(tx, `${a}/avatar.webp`))).rejects.toThrow(/row-level security/);
  });
});
