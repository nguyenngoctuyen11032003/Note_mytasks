// Coverage: src/services/auth.js, profile.js, timer.entrySeconds against the REAL local
// Supabase stack (GoTrue + PostgREST + Postgres), called the way the UI calls them
// (src/pages/auth.js, src/pages/settings.js, src/main.js).
//
// The local stack runs WITHOUT a mail server, so GoTrue answers /recover with
// 500 "Error sending recovery email". Password-reset tests therefore:
//   - check the exact request supabase-js puts on the wire (redirect_to, PKCE challenge),
//   - check 5xx → AppError 'server_error' (never 'network'),
//   - complete the reset end to end by standing in for the e-mail: the recovery token
//     is minted with admin.generateLink and the PKCE link is opened like a browser would.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { setClient } from './clientProxy.js';
import { LOCAL, admin, anonClient, newUser, deleteUser } from './env.js';
import { AppError } from '../../src/services/errors.js';
import * as auth from '../../src/services/auth.js';
import * as profile from '../../src/services/profile.js';
import * as timer from '../../src/services/timer.js';
import * as dashboard from '../../src/services/dashboard.js';
import { appBaseUrl } from '../../src/core/config.js';

const NOSESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const APP = 'http://localhost:5173/'; // tests/integration/setup.js window.location
const RESET_URL = `${APP}#/reset-password`;
const DB_URL = process.env.IT_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const users = [];
async function user() {
  const u = await newUser();
  users.push(u);
  setClient(u.client);
  return u;
}
afterEach(async () => {
  while (users.length) await deleteUser(users.pop().user);
});

async function expectAppError(p, code, field) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect(err.code).toBe(code);
  if (field !== undefined) expect(err.details?.field).toBe(field);
  return err;
}

/** Can `email/password` sign in? (fresh client, so the test's session is untouched) */
async function canSignIn(email, password) {
  const { error } = await anonClient().auth.signInWithPassword({ email, password });
  return !error;
}

/** Real fetch, recording every request (url + parsed JSON body). */
function recordingFetch(log, override) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    log.push({ url: new URL(url), method: init.method, body });
    const r = override ? await override(url, init) : undefined;
    return r ?? fetch(input, init);
  };
}
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/** The browser client config (src/core/supabase.js) minus persistence. */
const pkceClient = (fetchImpl) => createClient(LOCAL.url, LOCAL.anon, {
  auth: { ...NOSESSION, flowType: 'pkce' },
  ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
});

// ===========================================================================
describe('auth.onAuthChange', () => {
  it('delivers SIGNED_IN / SIGNED_OUT with the session; unsubscribe stops delivery', async () => {
    const u = await user();
    const c = anonClient();
    setClient(c);
    const events = [];
    const off = auth.onAuthChange((event, session) => events.push({ event, email: session?.user?.email ?? null }));
    expect(typeof off).toBe('function');

    await auth.signIn(u.email.toUpperCase(), u.password); // the form does not lowercase; the service does
    await auth.signOut();
    await vi.waitFor(() => expect(events.map((e) => e.event)).toContain('SIGNED_OUT'));

    const seq = events.map((e) => e.event).filter((e) => e !== 'INITIAL_SESSION');
    expect(seq).toEqual(['SIGNED_IN', 'SIGNED_OUT']);
    expect(events.find((e) => e.event === 'SIGNED_IN').email).toBe(u.email);
    expect(events.find((e) => e.event === 'SIGNED_OUT').email).toBeNull();

    off();
    const n = events.length;
    await auth.signIn(u.email, u.password);
    await auth.signOut();
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(n);
    off(); // idempotent
  });

  it('getSession reflects sign-in / sign-out', async () => {
    const u = await user();
    const c = anonClient();
    setClient(c);
    expect(await auth.getSession()).toBeNull();
    await auth.signIn(u.email, u.password);
    expect((await auth.getSession()).user.id).toBe(u.user.id);
    await auth.signOut();
    expect(await auth.getSession()).toBeNull();
    await auth.signOut(); // already signed out: no throw (session missing is ignored)
  });

  it('signIn maps wrong password to invalid_credentials and validates input', async () => {
    const u = await user();
    setClient(anonClient());
    await expectAppError(auth.signIn(u.email, 'wrong-password'), 'invalid_credentials');
    await expectAppError(auth.signIn('', 'x'), 'invalid_input', 'email');
    await expectAppError(auth.signIn('not-an-email', 'x'), 'invalid_input', 'email');
    await expectAppError(auth.signIn(u.email, ''), 'invalid_input', 'password');
  });
});

// ===========================================================================
describe('auth.updatePassword (settings page + reset page)', () => {
  it('new password works, old one no longer does; USER_UPDATED is emitted', async () => {
    const u = await user();
    const events = [];
    const off = auth.onAuthChange((e) => events.push(e));
    const next = 'Brand-new-pass-456!';
    // settings.js: verifyPassword(current) then updatePassword(new)
    await auth.verifyPassword(u.email, u.password);
    const data = await auth.updatePassword(next);
    expect(data.user.id).toBe(u.user.id);
    await vi.waitFor(() => expect(events).toContain('USER_UPDATED'));
    off();
    expect(await canSignIn(u.email, u.password)).toBe(false);
    expect(await canSignIn(u.email, next)).toBe(true);
    await expectAppError(auth.verifyPassword(u.email, u.password), 'invalid_credentials');
  });

  it('same password → same_password (server), too short → invalid_input on field password (client)', async () => {
    const u = await user();
    const e = await expectAppError(auth.updatePassword(u.password), 'same_password');
    expect(e.message).toMatch(/khác mật khẩu cũ/);
    await expectAppError(auth.updatePassword('1234567'), 'invalid_input', 'password'); // 7 < 8 (config.toml minimum_password_length)
    await expectAppError(auth.updatePassword(''), 'invalid_input', 'password');
    await expectAppError(auth.updatePassword(null), 'invalid_input', 'password');
    // exactly 8 is accepted by both the service and GoTrue
    await auth.updatePassword('abcd1234');
    expect(await canSignIn(u.email, 'abcd1234')).toBe(true);
  });

  it('signed out → session_expired', async () => {
    setClient(anonClient());
    await expectAppError(auth.updatePassword('Another-pass-789'), 'session_expired');
  });
});

// ===========================================================================
describe('auth.requestPasswordReset / resendConfirmation — request shape', () => {
  it('input validation (nothing is sent)', async () => {
    const log = [];
    setClient(pkceClient(recordingFetch(log)));
    await expectAppError(auth.requestPasswordReset(''), 'invalid_input', 'email');
    await expectAppError(auth.requestPasswordReset('   '), 'invalid_input', 'email');
    await expectAppError(auth.requestPasswordReset('a@b'), 'invalid_input', 'email');
    await expectAppError(auth.requestPasswordReset(null), 'invalid_input', 'email');
    await expectAppError(auth.resendConfirmation('no spaces@x.io'), 'invalid_input', 'email');
    await expectAppError(auth.resendConfirmation(undefined), 'invalid_input', 'email');
    expect(log).toHaveLength(0);
  });

  it('appBaseUrl drops the hash route and query (PKCE ?code must not survive into the link)', () => {
    expect(appBaseUrl()).toBe(APP);
    const saved = window.location;
    try {
      window.location = { href: 'https://me.github.io/Note_mytasks/?code=abc#/forgot-password', origin: 'https://me.github.io' };
      expect(appBaseUrl()).toBe('https://me.github.io/Note_mytasks/');
      window.location = { href: 'https://me.github.io/Note_mytasks/index.html#/login', origin: 'https://me.github.io' };
      expect(appBaseUrl()).toBe('https://me.github.io/Note_mytasks/');
    } finally {
      window.location = saved;
    }
  });

  it('requestPasswordReset: redirect_to = <base>#/reset-password, PKCE challenge sent, email normalised', async () => {
    const log = [];
    const calls = [];
    const c = pkceClient(recordingFetch(log, (url) => (url.includes('/recover') ? json(200, {}) : undefined)));
    const orig = c.auth.resetPasswordForEmail.bind(c.auth);
    c.auth.resetPasswordForEmail = (...a) => { calls.push(a); return orig(...a); };
    setClient(c);
    await auth.requestPasswordReset('  Some.User@Example.TEST ');
    expect(calls).toEqual([['some.user@example.test', { redirectTo: RESET_URL }]]);
    const req = log.find((r) => r.url.pathname.endsWith('/auth/v1/recover'));
    expect(req.method).toBe('POST');
    expect(req.url.searchParams.get('redirect_to')).toBe(RESET_URL);
    expect(req.body.email).toBe('some.user@example.test');
    expect(req.body.code_challenge_method).toBe('s256');
    expect(req.body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('requestPasswordReset under a GitHub Pages sub-path keeps the sub-path', async () => {
    const log = [];
    setClient(pkceClient(recordingFetch(log, () => json(200, {}))));
    const saved = window.location;
    try {
      window.location = { href: 'https://me.github.io/Note_mytasks/#/forgot-password', origin: 'https://me.github.io' };
      await auth.requestPasswordReset('x@example.test');
    } finally {
      window.location = saved;
    }
    expect(log[0].url.searchParams.get('redirect_to')).toBe('https://me.github.io/Note_mytasks/#/reset-password');
  });

  it('resendConfirmation: type signup, redirect_to = app base (no hash route), PKCE challenge', async () => {
    const log = [];
    const u = await newUser();
    users.push(u);
    setClient(pkceClient(recordingFetch(log)));
    // Real GoTrue: an already-confirmed address answers 200 without sending mail.
    await expect(auth.resendConfirmation(` ${u.email.toUpperCase()} `)).resolves.toBeDefined();
    const req = log.find((r) => r.url.pathname.endsWith('/auth/v1/resend'));
    expect(req.url.searchParams.get('redirect_to')).toBe(APP);
    expect(req.body).toMatchObject({ email: u.email, type: 'signup', code_challenge_method: 's256' });
    // Unknown address: same answer (no account enumeration).
    await expect(auth.resendConfirmation('nobody-here@example.test')).resolves.toBeDefined();
  });

  it('signUp sends emailRedirectTo = app base too (same confirmation link as resend)', async () => {
    const log = [];
    setClient(pkceClient(recordingFetch(log)));
    const email = `it-signup-${Date.now()}@example.test`;
    const data = await auth.signUp(email, 'Signup-pass-123', '  Tester  ');
    if (data?.user) users.push({ user: data.user });
    const req = log.find((r) => r.url.pathname.endsWith('/auth/v1/signup'));
    expect(req.url.searchParams.get('redirect_to')).toBe(APP);
    expect(req.body.data).toEqual({ display_name: 'Tester' });
  });
});

// ===========================================================================
describe('auth: server / network failures', () => {
  it('real GoTrue without a mail server: /recover 500 → server_error (not network/unknown)', async () => {
    const u = await user();
    setClient(pkceClient());
    let err = null;
    try { await auth.requestPasswordReset(u.email); } catch (e) { err = e; }
    // With a mail server the request succeeds; without one it must be server_error.
    if (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('server_error');
    }
  });

  it.each([500, 502, 503, 504])('HTTP %i from GoTrue → server_error for reset and resend', async (status) => {
    const body = { code: status, error_code: 'unexpected_failure', msg: 'Error sending recovery email' };
    setClient(pkceClient(recordingFetch([], () => json(status, body))));
    await expectAppError(auth.requestPasswordReset('x@example.test'), 'server_error');
    await expectAppError(auth.resendConfirmation('x@example.test'), 'server_error');
    await expectAppError(auth.signIn('x@example.test', 'whatever1'), 'server_error');
  });

  it('no response at all → network', async () => {
    setClient(pkceClient(async () => { throw new TypeError('fetch failed'); }));
    await expectAppError(auth.requestPasswordReset('x@example.test'), 'network');
    await expectAppError(auth.resendConfirmation('x@example.test'), 'network');
  });

  it('429 → rate_limited', async () => {
    setClient(pkceClient(async () => json(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' })));
    await expectAppError(auth.requestPasswordReset('x@example.test'), 'rate_limited');
    await expectAppError(auth.resendConfirmation('x@example.test'), 'rate_limited');
  });
});

// ===========================================================================
describe('password reset end to end (PKCE + hash router)', () => {
  let pgc;
  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost'].includes(new URL(DB_URL).hostname)).toBe(true);
    pgc = new pg.Client({ connectionString: DB_URL });
    await pgc.connect();
  });
  afterEach(async () => { await pgc?.end(); });

  it('reset request → e-mail link → ?code=…#/reset-password → exchange → PASSWORD_RECOVERY → updatePassword', async () => {
    const u = await newUser();
    users.push(u);
    // Browser client; the mail step is the only thing stubbed: GoTrue's 500
    // "Error sending recovery email" (no mail server) is answered as the 200 a mailer gives.
    const mailer = (url, init) => (url.includes('/recover')
      ? fetch(url, init).then((r) => (r.status >= 500 ? json(200, {}) : r))
      : undefined);
    const c = pkceClient(recordingFetch([], mailer));
    setClient(c);
    const events = [];
    const off = auth.onAuthChange((e) => events.push(e));

    await auth.requestPasswordReset(u.email); // forgot-password page
    const { rows: flows } = await pgc.query(
      "select count(*)::int n from auth.flow_state where user_id = $1 and authentication_method = 'recovery'", [u.user.id]);
    expect(flows[0].n).toBe(1); // PKCE flow registered server-side

    // "The e-mail": mint a recovery token and give it the PKCE prefix the mailer would use.
    const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'recovery', email: u.email, options: { redirectTo: RESET_URL } });
    expect(le).toBeNull();
    const hash = link.properties.hashed_token;
    await pgc.query("update auth.users set recovery_token = 'pkce_' || recovery_token where id = $1", [u.user.id]);
    await pgc.query("update auth.one_time_tokens set token_hash = 'pkce_' || token_hash where user_id = $1 and token_type = 'recovery_token'", [u.user.id]);

    // The user clicks the link.
    const verify = `${LOCAL.url}/auth/v1/verify?token=pkce_${hash}&type=recovery&redirect_to=${encodeURIComponent(RESET_URL)}`;
    const res = await fetch(verify, { redirect: 'manual' });
    expect(res.status).toBe(303);
    const landed = new URL(res.headers.get('location'));
    // PKCE puts the code in the QUERY: the hash route survives intact for the router.
    expect(landed.origin + landed.pathname).toBe(APP);
    expect(landed.hash).toBe('#/reset-password');
    const code = landed.searchParams.get('code');
    expect(code).toMatch(/^[0-9a-f-]{36}$/);

    // supabase-js (detectSessionInUrl) exchanges it with the stored verifier.
    const { data: ex, error: xe } = await c.auth.exchangeCodeForSession(code);
    expect(xe).toBeNull();
    expect(ex.session.user.id).toBe(u.user.id);
    expect(events).toContain('PASSWORD_RECOVERY'); // main.js switches to recovery mode on this

    // reset-password page
    const next = 'Recovered-pass-321';
    await auth.updatePassword(next);
    off();
    expect(await canSignIn(u.email, u.password)).toBe(false);
    expect(await canSignIn(u.email, next)).toBe(true);

    // The code is single-use.
    const again = await pkceClient().auth.exchangeCodeForSession(code);
    expect(again.error).toBeTruthy();
  });

  it('implicit-flow link (no PKCE) would put tokens in a second #fragment — why the app uses PKCE', async () => {
    const u = await newUser();
    users.push(u);
    const { data: link } = await admin.auth.admin.generateLink({ type: 'recovery', email: u.email, options: { redirectTo: RESET_URL } });
    const res = await fetch(link.properties.action_link, { redirect: 'manual' });
    const loc = res.headers.get('location');
    expect(loc.startsWith(`${RESET_URL}#access_token=`)).toBe(true); // redirect URL is allow-listed (not site_url fallback)
  });

  it('recovery via token_hash (verifyOtp) also signs in for updatePassword', async () => {
    const u = await newUser();
    users.push(u);
    const c = anonClient();
    setClient(c);
    const events = [];
    const off = auth.onAuthChange((e) => events.push(e));
    const { data: link } = await admin.auth.admin.generateLink({ type: 'recovery', email: u.email });
    const { error } = await c.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'recovery' });
    expect(error).toBeNull();
    expect(events).toContain('PASSWORD_RECOVERY');
    off();
    await auth.updatePassword('Otp-recovered-1');
    expect(await canSignIn(u.email, 'Otp-recovered-1')).toBe(true);
    // A consumed link maps to link_expired.
    const r2 = await anonClient().auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'recovery' });
    const { toAppError } = await import('../../src/services/errors.js');
    expect(toAppError(r2.error).code).toBe('link_expired');
  });
});

// ===========================================================================
describe('profile: device-local preferences (localStorage)', () => {
  let store;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('avatar colour: validated, persisted under nm.avatarColor, cleared with null', () => {
    expect(profile.getAvatarColor()).toBeNull();
    expect(profile.setAvatarColor('#12abEF')).toBe('#12abEF');
    expect(store.get('nm.avatarColor')).toBe('#12abEF');
    expect(profile.getAvatarColor()).toBe('#12abEF');
    for (const bad of ['red', '#fff', '#1234567', '12abef', '', undefined]) {
      expect(profile.setAvatarColor(bad)).toBeNull();
      expect(store.has('nm.avatarColor')).toBe(false);
    }
    store.set('nm.avatarColor', 'javascript:alert(1)'); // tampered storage
    expect(profile.getAvatarColor()).toBeNull();
  });

  it('home page: whitelisted paths only, persisted under nm.home (key main.js reads)', () => {
    expect(profile.getHomePage()).toBe('/dashboard');
    for (const { path } of profile.HOME_PAGES) {
      expect(profile.setHomePage(path)).toBe(path);
      expect(store.get('nm.home')).toBe(path);
      expect(profile.getHomePage()).toBe(path);
    }
    expect(profile.setHomePage('/settings')).toBe('/dashboard');
    expect(profile.setHomePage('https://evil.example')).toBe('/dashboard');
    expect(profile.setHomePage(undefined)).toBe('/dashboard');
    expect(store.get('nm.home')).toBe('/dashboard');
    store.set('nm.home', '/nope');
    expect(profile.getHomePage()).toBe('/dashboard');
  });

  it('storage unavailable (private mode / throws) → defaults, no throw', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('SecurityError'); },
    });
    expect(profile.getAvatarColor()).toBeNull();
    expect(profile.getHomePage()).toBe('/dashboard');
    expect(profile.setAvatarColor('#000000')).toBe('#000000');
    expect(profile.setHomePage('/notes')).toBe('/notes');
  });
});

// ===========================================================================
describe('profile.isValidTimezone', () => {
  it('accepts IANA zones (incl. DST zones and UTC), rejects junk', () => {
    for (const tz of ['Asia/Ho_Chi_Minh', 'UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'America/Sao_Paulo', 'Asia/Kolkata']) {
      expect(profile.isValidTimezone(tz), tz).toBe(true);
    }
    for (const tz of ['', '   ', null, undefined, 42, {}, 'Mars/Olympus_Mons', 'Asia/Hanoi', 'Etc/Unknown', 'Z']) {
      expect(profile.isValidTimezone(tz), String(tz)).toBe(false);
    }
  });

  it('every zone the UI accepts as valid is accepted by the database', async () => {
    await user();
    for (const tz of ['Asia/Saigon', 'US/Pacific', 'Etc/GMT+7', 'EST5EDT', 'Europe/Kyiv']) {
      expect(profile.isValidTimezone(tz)).toBe(true);
      const p = await profile.updateProfile({ timezone: tz });
      expect(p.timezone).toBe(tz);
    }
  });

  // Regression: Intl accepts lower-case names and numeric offsets, Postgres
  // (profiles_validate_timezone → pg_timezone_names) does not, so these used to pass
  // isValidTimezone and then fail on the server without a `timezone` field.
  it('isValidTimezone agrees with the DB on case / offsets', async () => {
    await user();
    for (const tz of ['asia/ho_chi_minh', 'utc', '+07:00']) {
      if (!profile.isValidTimezone(tz)) continue;
      await profile.updateProfile({ timezone: tz }); // must not reach the server and fail there
    }
  });

  it('server-side rejection of an unknown zone maps to invalid_input', async () => {
    await user();
    await expectAppError(profile.updateProfile({ timezone: 'Mars/Olympus_Mons' }), 'invalid_input', 'timezone'); // client-side
  });
});

// ===========================================================================
describe('profile.updateProfile timezone → server "today" follows', () => {
  const dayIn = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

  it('user_today / dashboard_summary.today / user_day switch with the profile timezone', async () => {
    const u = await user();
    // UTC+14 and UTC-11 are always on different calendar days.
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Ho_Chi_Minh']) {
      const p = await profile.updateProfile(u.user.id, { timezone: tz }); // compat signature (shell.js)
      expect(p.timezone).toBe(tz);
      expect((await profile.getProfile()).timezone).toBe(tz);
      const before = dayIn(tz);
      const { data: today } = await u.client.rpc('user_today');
      const summary = await dashboard.summary();
      const { data: tzName } = await u.client.rpc('current_user_timezone');
      const after = dayIn(tz);
      expect([before, after]).toContain(today);
      expect([before, after]).toContain(summary.today);
      expect(tzName).toBe(tz);
    }
    await profile.updateProfile({ timezone: 'Pacific/Pago_Pago' });
    const { data: a } = await u.client.rpc('user_today');
    await profile.updateProfile({ timezone: 'Pacific/Kiritimati' });
    const { data: b } = await u.client.rpc('user_today');
    expect(a).not.toBe(b);
  });

  it('DST: user_day around the America/New_York transitions', async () => {
    const u = await user();
    await profile.updateProfile({ timezone: 'America/New_York' });
    const cases = [
      ['2026-03-08T04:59:00Z', '2026-03-07'], // 23:59 EST
      ['2026-03-08T05:00:00Z', '2026-03-08'], // 00:00 EST
      ['2026-03-09T03:59:00Z', '2026-03-08'], // 23:59 EDT (after spring-forward)
      ['2026-03-09T04:00:00Z', '2026-03-09'],
      ['2026-11-01T03:59:00Z', '2026-10-31'], // 23:59 EDT
      ['2026-11-01T04:00:00Z', '2026-11-01'], // 00:00 EDT
      ['2026-11-02T04:59:00Z', '2026-11-01'], // 23:59 EST (after fall-back)
      ['2026-11-02T05:00:00Z', '2026-11-02'],
    ];
    for (const [ts, day] of cases) {
      const { data, error } = await u.client.rpc('user_day', { p_ts: ts });
      expect(error).toBeNull();
      expect(data, ts).toBe(day);
    }
  });

  it('other user is unaffected by my timezone change', async () => {
    const a = await user();
    const b = await user();
    setClient(a.client);
    await profile.updateProfile({ timezone: 'Pacific/Kiritimati' });
    const { data } = await b.client.rpc('current_user_timezone');
    expect(data).toBe('Asia/Ho_Chi_Minh');
  });
});

// ===========================================================================
describe('timer.entrySeconds', () => {
  it('finished entry → duration_seconds; running → elapsed to now; clock skew → 0', () => {
    const now = Date.parse('2026-10-09T10:00:00Z');
    expect(timer.entrySeconds({ started_at: '2026-10-09T09:00:00Z', duration_seconds: 1800 }, now)).toBe(1800);
    expect(timer.entrySeconds({ started_at: '2026-10-09T09:00:00Z', duration_seconds: '90' }, now)).toBe(90);
    expect(timer.entrySeconds({ started_at: '2026-10-09T09:00:00Z', duration_seconds: 0 }, now)).toBe(0);
    expect(timer.entrySeconds({ started_at: '2026-10-09T09:58:30.900Z', duration_seconds: null }, now)).toBe(89);
    expect(timer.entrySeconds({ started_at: '2026-10-09T09:58:30Z', ended_at: null }, now)).toBe(90);
    expect(timer.entrySeconds({ started_at: '2026-10-09T10:00:05Z', duration_seconds: null }, now)).toBe(0);
  });

  it('on real rows: manual entry, running timer counts up, stopped entry uses the generated column', async () => {
    await user();
    const end = new Date(Date.now() - 2 * 3600_000).toISOString();
    const manual = await timer.logTime({ startedAt: new Date(Date.parse(end) - 3_723_000).toISOString(), endedAt: end, description: 'manual' });
    expect(timer.entrySeconds(manual)).toBe(3723);

    const started = await timer.start(null, 'cov');
    expect(started.duration_seconds).toBeNull();
    const t0 = Date.parse(started.started_at);
    expect(timer.entrySeconds(started, t0 + 5_000)).toBe(5);
    expect(timer.entrySeconds(started, t0 - 5_000)).toBe(0);
    const cur = await timer.current();
    expect(timer.entrySeconds(cur.entry)).toBeGreaterThanOrEqual(0);
    expect(timer.entrySeconds(cur.entry)).toBeLessThan(120);

    const stopped = await timer.stop();
    expect(stopped.duration_seconds).toBe(Math.round((Date.parse(stopped.ended_at) - Date.parse(stopped.started_at)) / 1000));
    expect(timer.entrySeconds(stopped, Date.now() + 10 ** 9)).toBe(stopped.duration_seconds); // `now` ignored once finished

    const rows = await timer.listEntries({});
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(timer.entrySeconds(r)).toBe(r.duration_seconds);
  });
});
