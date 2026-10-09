// Frontend-safe configuration. Only the project URL and the public anon key
// are exposed to the browser (Vite only bundles VITE_* variables).

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() || '';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || '';

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const APP_NAME = 'Note_mytasks';

/**
 * Base URL of the deployed app, keeping a GitHub Pages sub-path (/<repo>/).
 * Used for auth e-mail redirects — location.origin would drop the sub-path.
 */
export function appBaseUrl() {
  const u = new URL('./', window.location.href);
  u.search = '';
  u.hash = '';
  return u.href;
}
