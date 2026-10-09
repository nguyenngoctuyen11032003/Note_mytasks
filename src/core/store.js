// Minimal global state with subscriptions. Holds only user-scoped session data
// that several pages share; page-specific data stays inside each page.

const state = {
  session: null,
  user: null,
  profile: null,
  categories: [],       // both kinds; filter with categoriesOf()
  runningEntry: null,   // time_entries row with ended_at = null (+ task)
};

const subs = new Set();

export function get() {
  return state;
}

export function set(patch) {
  Object.assign(state, patch);
  subs.forEach((fn) => fn(state, patch));
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Wipe everything user-scoped (sign-out / expired session). */
export function clearUserState() {
  set({ session: null, user: null, profile: null, categories: [], runningEntry: null });
  try {
    localStorage.removeItem('nm.pausedSession');
    localStorage.removeItem('nm.ctx'); // cached profile + categories (main.js)
  } catch {}
}

export const categoriesOf = (kind) =>
  state.categories.filter((c) => c.kind === kind).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'vi'));

export const categoryById = (id) => state.categories.find((c) => c.id === id) || null;

export function displayName() {
  return state.profile?.display_name || state.user?.email?.split('@')[0] || 'bạn';
}
