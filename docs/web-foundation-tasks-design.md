# Web foundation and task management design

Date: 2026-10-09

## Goal

Build the first usable Note_mytasks web slice: a responsive Vite application with Supabase authentication, an authenticated app shell, and task management backed by the existing PostgreSQL schema and RLS rules.

## Current project context

- The repository currently contains database migrations and architecture documents, but no `package.json`, `index.html`, `src/`, or web application code.
- `docs/ARCHITECTURE.md` chooses Vite, vanilla JavaScript modules, `@supabase/supabase-js`, CSS variables, and hash routing.
- The database model has `profiles`, `categories`, and `tasks`; default categories are created by the Auth sign-up trigger. RLS and composite foreign keys enforce per-user isolation.
- The local `.env` was recently created for project `mmmh…`. The remote schema and migration history have not yet been verified or deployed.

## Scope for this slice

### Included

- Vite project setup and responsive layout for desktop and mobile.
- Supabase client initialization using only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `.env`.
- Authentication screens and flow: sign up, sign in, sign out, session restoration, and password reset request. Use Supabase Auth PKCE as specified in the architecture.
- Hash-based routes for login and the authenticated application.
- Shared app shell with navigation, user identity, and a task workspace.
- Task list, search/filter by status and category, create/edit, mark complete/reopen, and delete with confirmation.
- Task fields aligned to the current schema: title, description, status, priority, category, due date, tags, and estimated minutes.
- Loading, empty, validation, success, and failure states in Vietnamese.
- Service modules as the only place that calls `supabase.from(...)`; page modules use services and shared UI components.

### Excluded

- Calendar, time tracking, KPI, expenses, budgets, shopping, reports, and account settings pages.
- A custom server, `JWT_SECRET`, `DATABASE_URL`, or SMTP secrets in frontend code or Vite-exposed variables.
- Demo data insertion. A new account gets the existing database-triggered default categories.
- Applying database migrations or deleting existing remote users/data as part of frontend implementation. The remote project/schema mismatch and TLS CA requirement must be resolved separately before claiming remote integration works.

## Architecture

```text
Browser
  main.js -> auth guard -> hash router -> shell/pages
  pages -> task/auth/category services -> Supabase JS client
  Supabase Auth + PostgREST -> PostgreSQL schema + RLS
```

Use the existing dependency boundaries from `docs/ARCHITECTURE.md`: pages call services; services call Supabase; core owns configuration, session, routing, and state; components own reusable dialogs, notifications, and empty/loading states. Do not add a framework or a second database schema.

## Authentication and data flow

1. Vite reads the project URL and public anon key from the `VITE_*` variables. No database password, SMTP password, or JWT signing secret is included in the frontend bundle.
2. Supabase Auth uses PKCE. On page load, the client restores the session before rendering authenticated routes.
3. New users sign up through Supabase Auth; the existing database trigger creates their profile and default categories.
4. Task services query and mutate `public.tasks` through the signed-in session. The database applies RLS and ownership constraints; the browser never supplies another user's `user_id`.
5. On sign out, clear user-scoped client state and route to the login screen.

## Interface behavior

- On desktop, use a compact navigation rail/sidebar and a wide task workspace. On narrow screens, collapse navigation behind an accessible menu.
- The task workspace shows a clear page title, search, status/category filters, and one primary create-task action.
- Each task row exposes completion, title, due date, priority, and category. Editing happens in a labeled dialog or dedicated form; destructive delete requires confirmation.
- Empty state offers a direct create action. Loading and errors remain visible and do not silently show an empty list.
- Vietnamese copy, `vi-VN` date/number formatting, and the existing VND/timezone defaults are used where applicable.

## Error handling and accessibility

- Map common Supabase Auth and PostgREST errors to concise Vietnamese messages; retain a safe generic fallback for unknown errors.
- Keep form values after failed saves, associate validation messages with fields, and disable duplicate submissions while a request is pending.
- Use semantic buttons/labels, keyboard-operable navigation/dialogs, visible focus states, and sufficient text contrast.
- Treat expired sessions by returning the user to sign in without leaking private task data from the previous session.

## Acceptance criteria

- A clean install starts with the documented Vite development command and builds with production settings.
- An unauthenticated visitor can sign up, sign in, request a password reset, and sign out through Supabase Auth.
- An authenticated user can create, edit, complete/reopen, filter/search, and delete their own tasks.
- Task queries and mutations go through service modules and rely on RLS for ownership; the frontend never uses a service-role or database credential.
- The interface works at desktop and mobile widths and provides loading, empty, validation, success, and error feedback.
- Remote behavior is only reported as verified after the target project is confirmed to have the matching migration applied; the current project has not yet met that condition.

## Deployment

Keep deployment static and compatible with GitHub Pages as described in the architecture document. Build-time configuration contains only the Supabase project URL and public anon key. Configure auth redirect URLs in the Supabase dashboard separately before production sign-up/reset flows.
