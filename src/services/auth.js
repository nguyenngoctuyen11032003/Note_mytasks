// Supabase Auth wrapper (PKCE). All errors are mapped to AppError.
import { appBaseUrl } from '../core/config.js';
import { db, run, invalid, AppError, toAppError } from './errors.js';

const MIN_PASSWORD = 6;

function vEmail(email) {
  const e = typeof email === 'string' ? email.trim() : '';
  if (!e) throw invalid('email', 'Hãy nhập email.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw invalid('email', 'Địa chỉ email không hợp lệ.');
  return e.toLowerCase();
}
function vPassword(password, { strength = true } = {}) {
  if (typeof password !== 'string' || password === '') throw invalid('password', 'Hãy nhập mật khẩu.');
  if (strength && password.length < MIN_PASSWORD) throw invalid('password', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự.`);
  return password;
}

export async function getSession() {
  const data = await run(db().auth.getSession());
  return data?.session ?? null;
}

/** Subscribe to auth changes. Returns an unsubscribe function. */
export function onAuthChange(fn) {
  const { data } = db().auth.onAuthStateChange((event, session) => fn(event, session));
  return () => data?.subscription?.unsubscribe();
}

export async function signIn(email, password) {
  return run(db().auth.signInWithPassword({ email: vEmail(email), password: vPassword(password, { strength: false }) }));
}

/** Returns { user, session } — session is null when e-mail confirmation is required. */
export async function signUp(email, password, displayName) {
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, 80) : '';
  const data = await run(
    db().auth.signUp({
      email: vEmail(email),
      password: vPassword(password),
      options: {
        data: name ? { display_name: name } : {}, // read by the handle_new_user trigger
        emailRedirectTo: appBaseUrl(),
      },
    }),
  );
  // Existing e-mail: Supabase returns a user without identities (no leak). Make it explicit.
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new AppError('user_already_exists');
  }
  return data;
}

/** Re-send the sign-up confirmation link (Supabase rate-limits this server-side). */
export async function resendConfirmation(email) {
  return run(db().auth.resend({ type: 'signup', email: vEmail(email), options: { emailRedirectTo: appBaseUrl() } }));
}

export async function signOut() {
  let res;
  try {
    res = await db().auth.signOut();
  } catch (e) {
    throw toAppError(e);
  }
  // Local session is cleared by supabase-js even when the server call fails.
  if (res?.error && !/session missing|session_not_found/i.test(`${res.error.message} ${res.error.code}`)) {
    throw toAppError(res.error);
  }
}

export async function requestPasswordReset(email) {
  return run(db().auth.resetPasswordForEmail(vEmail(email), { redirectTo: `${appBaseUrl()}#/reset-password` }));
}

export async function updatePassword(password) {
  return run(db().auth.updateUser({ password: vPassword(password) }));
}

/** Re-verify the current password before changing it (settings page). */
export async function verifyPassword(email, password) {
  return run(db().auth.signInWithPassword({ email: vEmail(email), password: vPassword(password, { strength: false }) }));
}
