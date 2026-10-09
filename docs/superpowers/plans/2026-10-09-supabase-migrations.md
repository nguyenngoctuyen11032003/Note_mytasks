# Supabase Migrations Implementation Plan

> **For agentic workers:** Use the `executing-plans` skill to perform this plan task-by-task. Keep each remote operation separate and inspect its output before continuing.

**Goal:** Make the existing Note_mytasks database model reproducible through Supabase migrations, clear all existing app data and Auth accounts once, and leave migrations as the only canonical schema definition.

**Architecture:** Convert the current schema and RLS SQL into an ordered initial migration without changing the defined data model. Keep demo seed data optional and outside the migration chain. Inspect the hosted database and migration history before mutation; adopt the migration baseline when it matches, then execute the user-requested one-time cleanup as a separate guarded operation.

**Tech Stack:** PostgreSQL 15+, Supabase CLI, Supabase Auth/Postgres, PowerShell, SQL.

---

## File map

- Create `supabase/config.toml`: minimal CLI project configuration; disable automatic demo seeding.
- Create `supabase/migrations/20261009000100_initial_schema.sql`: canonical initial schema, triggers, functions, grants, and RLS copied from the current SQL files and reviewed in dependency order.
- Create `supabase/maintenance/clear_legacy_data.sql`: guarded one-time operation that removes all Auth accounts; existing app tables are expected to cascade from `auth.users` through their existing foreign keys.
- Keep `supabase/seed.sql` as a manual-only demo script, and confirm its UTF-8 Vietnamese strings remain intact.
- Delete `supabase/schema.sql` and `supabase/policies.sql` after verifying their contents are fully represented in the initial migration.
- Update `docs/ARCHITECTURE.md` with the migration workflow, manual-only seed behavior, and the fact that the UI is not yet implemented.

## Task 1: Establish Supabase CLI project configuration

**Files:** `supabase/config.toml`

- [ ] Check whether the Supabase CLI is available with `supabase --version` and whether Docker is available with `docker version`.
- [ ] If `supabase/config.toml` is absent, run `supabase init` from the project root. Do not overwrite either SQL file.
- [ ] Configure the generated project for PostgreSQL 15 or newer and set `[db.seed] sql_paths = []` so local resets never run demo data automatically.
- [ ] Inspect the final config and validate it with `supabase start` only if Docker and the CLI are available. If either is absent, record that local database validation is unavailable and continue with static SQL review plus remote read-only inventory.
- [ ] Do not add database passwords, SMTP secrets, API keys, access tokens, or connection strings to this file.

## Task 2: Build the canonical initial migration

**Files:** `supabase/migrations/20261009000100_initial_schema.sql`, `supabase/schema.sql`, `supabase/policies.sql`

- [ ] Create the migration directory and initial migration file.
- [ ] Copy the SQL definitions from `supabase/schema.sql` followed by `supabase/policies.sql`, preserving the existing definitions for `profiles`, `categories`, `tasks`, `time_entries`, `kpis`, `kpi_records`, `expenses`, `budgets`, `shopping_items`, and `activity_logs`.
- [ ] Preserve PostgreSQL 15 column-list `ON DELETE SET NULL`, composite ownership foreign keys, triggers, functions, indexes, grants, and every RLS policy.
- [ ] Review the source and migration with UTF-8 decoding. Confirm the Vietnamese default-category and demo names render correctly before removing the source files.
- [ ] Compare source and migration definitions for all ten tables, every function/trigger/index, and all policies. Remove `schema.sql` and `policies.sql` only after this comparison is complete.
- [ ] Keep `seed.sql` out of the migration. Ensure no migration inserts demo records or deletes Auth users.

## Task 3: Validate migration behavior on a disposable local database

**Files:** `supabase/migrations/20261009000100_initial_schema.sql`, `supabase/config.toml`

- [ ] When Docker and the CLI are available, run `supabase start` and then `supabase db reset --local` from the project root.
- [ ] Confirm reset completes with the initial migration and does not report demo seed execution.
- [ ] In the local database, inspect `information_schema.tables` for the ten expected public tables, `pg_policies` for RLS policies, `pg_trigger` for expected application triggers, and `pg_constraint` for composite ownership foreign keys.
- [ ] Confirm a newly inserted local Auth user receives a profile and the existing 14 default categories through `on_auth_user_created`.
- [ ] Run `supabase stop` after local inspection. Do not connect any of these local validation commands to the hosted project.

## Task 4: Inventory the hosted project without changing it

**Files:** none; read-only database inspection only

- [ ] Connect to the specified Supabase Postgres pooler using `psql` with an interactive password prompt (`-W`); do not put the password in the command, a URL, a file, or shell history.
- [ ] Query current database name/version, existing `public` tables, constraints, indexes, triggers, policies, Auth user count, and `supabase_migrations.schema_migrations` history.
- [ ] Compare the remote object inventory to the migration generated in Task 2. Do not run the migration or cleanup if unexpected tables, policies, or schema differences appear; reconcile those against the approved spec first.
- [ ] If the project is empty, apply the initial migration. If the schema already matches but has no migration record, mark the baseline applied using Supabase migration repair against the inspected project. If the history already contains the baseline, do not apply it again.
- [ ] If the CLI requires Supabase account linking or a personal access token that is not available, stop remote writes and report the precise missing authentication step; the Postgres password alone must not be put into an access-token field.

## Task 5: Create and run guarded one-time cleanup

**Files:** `supabase/maintenance/clear_legacy_data.sql`

- [ ] Write the script with an explicit session-variable guard that raises an exception unless `app.confirm_full_reset` equals `DELETE_ALL_NOTE_MYTASKS_DATA`.
- [ ] In a transaction, delete all rows from `auth.users`; allow the existing cascade constraints to remove the user-owned application records. Do not drop schemas, tables, project settings, or Supabase-managed infrastructure.
- [ ] Before execution, display the inspected Auth user count and per-table row counts from Task 4. Execute the cleanup only against the verified project and only after those counts are understood.
- [ ] Set the guard variable and run the script through `psql` with interactive password entry. Stop on any SQL error; do not retry with `CASCADE` or broaden the deletion.
- [ ] Re-query Auth and public table counts. Confirm zero Auth users and zero app rows, while all ten schema tables, policies, functions, and triggers remain present.
- [ ] Leave the script as an explicitly guarded maintenance artifact; do not put it in `supabase/migrations/` or configure it as a seed.

## Task 6: Document ongoing workflow and finish the schema-source transition

**Files:** `docs/ARCHITECTURE.md`, `supabase/seed.sql`, `supabase/schema.sql`, `supabase/policies.sql`

- [ ] Update the architecture document to say schema changes are made through ordered files in `supabase/migrations/`, and never by editing a second canonical schema file.
- [ ] Document that migrations configure structure and access rules; user records are written by the web app after it exists and signs in, under RLS. The current repository does not contain a UI or services layer to deploy or validate that flow.
- [ ] Document `seed.sql` as an optional manual demo script for a chosen account, never production migration input.
- [ ] Confirm `.env.example` still contains only frontend-safe public settings and no database/SMTP secrets.
- [ ] Review the final file list and search the repository for credential-like strings before reporting completion.

## Final acceptance checks

- [ ] The fresh local database can be recreated from the initial migration alone.
- [ ] The migration contains all current schema and RLS definitions, with no duplicate `schema.sql` or `policies.sql` files.
- [ ] The demo seed is excluded from migrations and automatic resets.
- [ ] The hosted database migration history is consistent with the inspected schema.
- [ ] Hosted cleanup is verified to remove all existing Auth accounts and app rows while retaining schema, policies, and project infrastructure.
- [ ] No credentials are written to the workspace or printed in command output.
- [ ] Note that frontend behavior remains unverified because the web application is not present in this repository.
