# Web Foundation and Task Management Implementation Plan

> **For agentic workers:** Use the `executing-plans` skill to implement this plan task-by-task. Steps use checkbox syntax for tracking. Work directly in the current workspace because it is not a Git repository and no worktree can be created.

**Goal:** Build the first usable Note_mytasks web slice with Supabase PKCE authentication, a responsive app shell, and task CRUD backed by the existing schema and RLS.

**Architecture:** Build a Vite single-page app with vanilla JavaScript and hash routes. Keep Supabase calls in service modules, use the public anon key from `VITE_*` variables, and rely on RLS instead of client-supplied user ownership. The first authenticated page is task management; later product modules remain out of scope.

**Tech Stack:** Vite, vanilla JavaScript ES modules, `@supabase/supabase-js`, CSS variables, Supabase Auth/PostgREST.

---

## File map

- Create `package.json` and `index.html`: Vite scripts, app metadata, and application mount point.
- Create `src/main.js`: startup, session bootstrap, route selection, and shell mounting.
- Create `src/core/config.js`, `src/core/supabase.js`, `src/core/router.js`, and `src/core/session.js`: frontend-safe configuration, Supabase client, hash routing, and user session state.
- Create `src/services/auth.js`, `src/services/tasks.js`, and `src/services/categories.js`: the only modules that call Supabase APIs.
- Create `src/components/`: app shell, task form, task row, confirm dialog, toast, and loading/empty/error states.
- Create `src/pages/login.js`, `src/pages/signup.js`, `src/pages/forgot-password.js`, and `src/pages/tasks.js`: route-specific UI.
- Create `src/css/tokens.css`, `src/css/base.css`, `src/css/layout.css`, `src/css/components.css`, and `src/css/pages.css`: responsive visual system and page styling.
- Update `.env.example`: retain only the public Vite URL/key with instructions for local setup.
- Create `README.md`: install, run, build, and Supabase redirect configuration.

## Task 1: Bootstrap the Vite app

**Files:** `package.json`, `index.html`, `.env.example`

- [ ] Initialize npm metadata with `npm init -y` from the project root.
- [ ] Install runtime and development dependencies with `npm install @supabase/supabase-js` and `npm install --save-dev vite`.
- [ ] Set `package.json` to ES modules and add scripts: `"dev": "vite"`, `"build": "vite build"`, and `"preview": "vite preview"`.
- [ ] Create `index.html` with `lang="vi"`, UTF-8 and viewport metadata, title `Note_mytasks`, `<div id="app"></div>`, and `/src/main.js` as a module entry.
- [ ] Update `.env.example` to include blank `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values plus a note that only the public anon key belongs in Vite. Do not copy any value from the local `.env`.

## Task 2: Create core configuration, Supabase client, session, and hash router

**Files:** `src/main.js`, `src/core/config.js`, `src/core/supabase.js`, `src/core/session.js`, `src/core/router.js`

- [ ] Create `src/core/config.js` and read `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_ANON_KEY`; throw a clear startup error when either is empty.
- [ ] Create one Supabase client in `src/core/supabase.js` with `auth: { flowType: 'pkce', autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }`.
- [ ] Create `src/core/session.js` with `getSession()`, `subscribe(callback)`, and `clearUserState()`; subscribe to `supabase.auth.onAuthStateChange` and return the subscription cleanup function.
- [ ] Create `src/core/router.js` with a route table for `#/login`, `#/signup`, `#/forgot-password`, and `#/tasks`; normalize unknown hashes to `#/login` and support `navigate(path)` plus `onRouteChange(callback)`.
- [ ] In `src/main.js`, load CSS, wait for the initial Supabase session, redirect signed-out users from `#/tasks` to `#/login`, and redirect signed-in users away from login/signup pages to `#/tasks`.
- [ ] Ensure sign-out clears any user-scoped task/category state before navigating to login.

## Task 3: Implement authentication service and screens

**Files:** `src/services/auth.js`, `src/pages/login.js`, `src/pages/signup.js`, `src/pages/forgot-password.js`, `src/components/toast.js`, `src/css/pages.css`

- [ ] Implement `signIn(email, password)`, `signUp(email, password, displayName)`, `signOut()`, and `requestPasswordReset(email)` in `src/services/auth.js` using the shared Supabase client.
- [ ] For sign-up, send `{ data: { display_name: displayName } }` so the existing Auth trigger can create the profile name; do not create profile/category rows from the browser.
- [ ] Build labeled Vietnamese forms for sign-in, sign-up, and reset request. Validate email shape, required values, and password minimum length before submission.
- [ ] Show a confirmation message when sign-up succeeds without an active session because email confirmation is enabled.
- [ ] Show pending, success, validation, and failure states; preserve entered form values after failed requests and prevent duplicate submissions.
- [ ] Add links between login, sign-up, and forgot-password routes. Do not expose SMTP or database configuration in these screens.

## Task 4: Implement category and task services

**Files:** `src/services/categories.js`, `src/services/tasks.js`

- [ ] Implement `listTaskCategories()` selecting `id,name,color,sort_order` from `categories`, filtering `kind = 'task'` and sorting by `sort_order` then `name`.
- [ ] Implement `listTasks({ search, status, categoryId })` selecting task fields plus the related category; apply supported status/category filters and order by `due_date` ascending with null dates last, then `created_at` descending.
- [ ] Implement `createTask(input)`, `updateTask(id, input)`, `setTaskStatus(id, status)`, and `deleteTask(id)` against `public.tasks`.
- [ ] Whitelist writable fields: `title`, `description`, `status`, `priority`, `category_id`, `tags`, `due_date`, and `estimated_minutes`. Never send `user_id`, `actual_minutes`, or `completed_at`; database defaults/triggers own those values.
- [ ] Keep all data access inside these service modules. Map Supabase errors to safe errors for the page layer without returning credentials or raw request headers.

## Task 5: Build shared app shell and task workspace

**Files:** `src/components/app-shell.js`, `src/components/task-row.js`, `src/components/task-form.js`, `src/components/confirm-dialog.js`, `src/components/empty-state.js`, `src/pages/tasks.js`, `src/css/layout.css`, `src/css/components.css`, `src/css/pages.css`

- [ ] Build a responsive sidebar on desktop and keyboard-accessible menu on narrow screens, with Note_mytasks identity, active Tasks navigation, signed-in email, and sign-out action.
- [ ] Build task rows showing completion control, title, due date, priority, category, and edit/delete actions.
- [ ] Build a task create/edit form for title, description, priority, task category, due date, tags, and estimated minutes. Require a trimmed title from 1 to 200 characters and follow the existing database constraints for all fields.
- [ ] Build a task workspace with page heading, search input, status filter, category filter, and a clear create action.
- [ ] On create/edit/toggle/delete success, reload the list and show a concise Vietnamese confirmation. Require confirmation before deletion.
- [ ] Render distinct loading, empty, no-filter-results, and error states. Empty/error states must not look like a valid empty task list.
- [ ] Keep search/filter state local to the page and reset it when the authenticated user changes.

## Task 6: Add visual system and responsive/accessibility details

**Files:** `src/css/tokens.css`, `src/css/base.css`, `src/css/layout.css`, `src/css/components.css`, `src/css/pages.css`

- [ ] Define CSS custom properties for a restrained warm-neutral surface, dark readable text, one clear blue action color, semantic success/error colors, spacing, radii, and focus rings.
- [ ] Style a focused editorial workspace rather than nested cards: clear page title, compact filters, readable task rows, and one primary action.
- [ ] At mobile widths, collapse the sidebar without horizontal overflow; keep task actions reachable and forms usable at 320px viewport width.
- [ ] Use semantic landmarks and buttons, visible keyboard focus, label every input, announce async feedback with an appropriate live region, and honor reduced-motion preferences.
- [ ] Format dates with `vi-VN`; use the project timezone for date interpretation without converting date-only `due_date` values through UTC.

## Task 7: Document setup and verify the build

**Files:** `README.md`, `package.json`, `.env.example`

- [ ] Create `README.md` with `npm install`, copying `.env.example` to `.env`, setting the public Supabase URL/anon key, `npm run dev`, `npm run build`, and Supabase Auth redirect URL setup.
- [ ] State that `.env` stays local, only `VITE_*` variables are bundled, and database/SMTP/JWT secrets must not use the `VITE_` prefix.
- [ ] Run `npm run build` from the project root. Expected output: Vite creates `dist/` and exits with code 0.
- [ ] Start `npm run dev` and confirm the app loads at the local Vite URL, displays the sign-in screen signed out, and keeps protected routes behind authentication. Do not claim hosted database integration until the correct Supabase project has the migration applied and can be verified over TLS.
- [ ] Do not add or run an automated test suite in this implementation; the requested verification here is the production build and a browser smoke check.

## Acceptance checklist

- [ ] Vite app starts and builds from the documented commands.
- [ ] Supabase Auth supports sign-up, sign-in, session restoration, sign-out, and password reset request through PKCE.
- [ ] Authenticated users can list, search/filter, create, edit, complete/reopen, and delete their own tasks.
- [ ] Categories are loaded from the existing `categories` table and are created for new accounts by the database trigger.
- [ ] No frontend code contains database password, SMTP password, JWT secret, or service-role key.
- [ ] Services are the only modules that query/mutate Supabase tables.
- [ ] Layout and forms remain usable on desktop and 320px mobile, with accessible labels/focus and clear load/empty/error states.
- [ ] No changes to unrelated schema or project data are made.
