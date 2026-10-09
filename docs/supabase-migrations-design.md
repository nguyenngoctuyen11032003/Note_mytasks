# Supabase migrations design

Date: 2026-10-09

## Goal

Make the existing PostgreSQL schema for Note_mytasks reproducible through ordered Supabase migrations. Keep the current database design as the sole schema definition, avoid parallel table definitions, and clear the existing project data once as a separately controlled operation.

## Current project state

- `docs/ARCHITECTURE.md` describes Phase 1 as database architecture; the web UI and application source are not present yet.
- `supabase/schema.sql` defines the tables, constraints, indexes, functions, and triggers.
- `supabase/policies.sql` defines grants and row-level security policies.
- `supabase/seed.sql` inserts optional demo records for an existing Auth user.
- `.env.example` only documents frontend Supabase URL and public anon key. Database and SMTP secrets must not be added to the repository.

The migration schema must therefore match the architecture and existing SQL, not an unavailable web implementation.

## Proposed structure

1. Create ordered SQL migrations under `supabase/migrations/` from the existing schema and policy definitions. Use one initial migration unless the SQL dependency order makes two migrations clearer. Preserve all existing tables, column names, constraints, indexes, triggers, functions, grants, and RLS rules.
2. Make the migration files the only canonical schema source. Remove the standalone `schema.sql` and `policies.sql` after their definitions have been moved and reviewed, so they cannot drift from migration history.
3. Keep demo data optional and separate from schema migrations. It must never be run automatically against the production project.
4. Perform the requested one-time cleanup as a distinct, explicit SQL operation after inspecting the remote project. It must remove existing application rows and Auth users, while retaining Supabase-managed schemas and project infrastructure. Do not embed cleanup in a migration that will run on fresh or future environments.
5. Apply the migrations to the Supabase project only after confirming the remote schema state and migration history. If the existing database already contains these objects, adopt the baseline without recreating or duplicating them.

## Data model to preserve

The existing schema defines `profiles`, `categories`, `tasks`, `time_entries`, `kpis`, `kpi_records`, `expenses`, `budgets`, `shopping_items`, and `activity_logs`. It includes per-user ownership, composite foreign keys for user-owned references, RLS, and trigger-maintained derived values. No extra tables should be introduced for this migration conversion.

## Data flow

Migrations create the database structures and access rules. The browser application, when implemented, will connect using the Supabase project URL and public anon key; authenticated user actions will write rows through Supabase APIs, with RLS enforcing ownership. Database credentials and SMTP credentials remain outside the frontend and repository. The current project has no app code to verify this flow yet.

## Cleanup and failure handling

- Inspect the target project and migration history before any mutation.
- Keep cleanup separate from schema setup and execute it only once, after the migration plan is reviewed.
- Use a transaction where Supabase permits it; otherwise use a reviewed dependency-safe order and verify the resulting row counts and Auth user count.
- If the live schema differs from the files, stop and reconcile the differences before applying migrations; never blindly drop the `public` schema or Supabase-managed schemas.
- Do not include passwords, SMTP credentials, API keys, or connection strings in files, shell history, logs, or migration SQL.

## Acceptance criteria

- A clean Supabase database can receive the existing schema and policies from ordered migrations.
- There is one canonical schema definition, with no duplicate standalone schema or policy SQL.
- The one-time cleanup is separate from migrations and removes all existing app data and Auth accounts only after remote state is inspected.
- Demo records remain optional and are not inserted by production migrations.
- The files match the project architecture; UI compatibility remains unverified until the web application exists.

## Out of scope

- Implementing the web UI or app services.
- Configuring SMTP in Supabase.
- Adding demo records to the production database.
- Changing the database model beyond what the existing SQL defines.
