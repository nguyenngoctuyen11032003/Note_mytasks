// Supabase Auth wrapper (PKCE). All errors are mapped to AppError.
import { appBaseUrl } from '../core/config.js';
import { db, run, invalid, AppError, toAppError } from './errors.js';

// Same rule as the sign-up / reset / settings forms (8 characters).
const MIN_PASSWORD = 8;

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
        emailRedirectTo: `${appBaseUrl()}?flow=signup`,
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
  return run(db().auth.resend({ type: 'signup', email: vEmail(email), options: { emailRedirectTo: `${appBaseUrl()}?flow=signup` } }));
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
  // ?flow=recovery, not '#/reset-password': the email templates append
  // '&token_hash=…&type=recovery' to {{ .RedirectTo }}, the legacy PKCE link
  // appends '&code=…' — both need the query form. main.js reads ?flow so it
  // can route a PKCE recovery session to the reset page.
  return run(db().auth.resetPasswordForEmail(vEmail(email), { redirectTo: `${appBaseUrl()}?flow=recovery` }));
}

/**
 * Verifies a token_hash email link (supabase/templates/*.html) in this browser.
 * Unlike the PKCE ?code link it works in any browser/device, and link scanners
 * that merely open the URL can't burn the token — it is spent only here.
 * type: 'recovery' | 'email' (sign-up confirmation) | 'email_change'.
 */
export async function verifyEmailLink(tokenHash, type) {
  if (!tokenHash || !['recovery', 'email', 'signup', 'email_change', 'magiclink', 'invite'].includes(type)) {
    throw new AppError('link_expired');
  }
  return run(db().auth.verifyOtp({ token_hash: tokenHash, type }));
}

export async function updatePassword(password) {
  return run(db().auth.updateUser({ password: vPassword(password) }));
}

/** Re-verify the current password before changing it (settings page). */
export async function verifyPassword(email, password) {
  return run(db().auth.signInWithPassword({ email: vEmail(email), password: vPassword(password, { strength: false }) }));
}
