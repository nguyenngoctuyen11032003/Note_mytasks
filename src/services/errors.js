// Error model + shared helpers for the service layer.
//
// Every service function throws AppError { code, message (Vietnamese), cause, details }.
// `message` is always a short, user-facing Vietnamese sentence — raw SQL text,
// constraint names or HTTP headers never reach it (they stay in `cause`).
//
// This module also hosts the small helpers every service shares (client access,
// result unwrapping, whitelisting, validation, numeric normalisation) so that the
// service files themselves stay declarative.

import { supabase } from '../core/supabase.js';

// ---------------------------------------------------------------------------
// AppError
// ---------------------------------------------------------------------------

export const MESSAGES = {
  not_configured: 'Ứng dụng chưa được cấu hình kết nối Supabase.',
  network: 'Không kết nối được máy chủ. Kiểm tra mạng và thử lại.',
  duplicate: 'Dữ liệu bị trùng với một mục đã có.',
  invalid_reference: 'Mục liên kết không tồn tại hoặc không thuộc về bạn.',
  invalid_input: 'Dữ liệu không hợp lệ.',
  forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  not_found: 'Không tìm thấy dữ liệu (có thể đã bị xóa).',
  timer_already_running: 'Đang có một bộ đếm giờ chạy. Hãy dừng nó trước.',
  task_closed: 'Công việc đã hoàn thành hoặc đã hủy, không thể tính giờ.',
  time_overlap: 'Khoảng thời gian bị chồng lấn với một phiên khác.',
  already_purchased: 'Món này đã được đánh dấu là đã mua.',
  invalid_credentials: 'Email hoặc mật khẩu không đúng.',
  email_not_confirmed: 'Email chưa được xác nhận. Hãy mở hộp thư và bấm vào liên kết xác nhận.',
  user_already_exists: 'Email này đã được đăng ký. Hãy đăng nhập hoặc đặt lại mật khẩu.',
  weak_password: 'Mật khẩu quá yếu. Hãy dùng ít nhất 6 ký tự, kết hợp chữ và số.',
  same_password: 'Mật khẩu mới phải khác mật khẩu cũ.',
  rate_limited: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.',
  invalid_email: 'Địa chỉ email không hợp lệ.',
  signup_disabled: 'Hệ thống đang tạm khóa đăng ký tài khoản mới.',
  link_expired: 'Liên kết đã hết hạn hoặc được mở ở trình duyệt khác. Hãy yêu cầu liên kết mới.',
  session_expired: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  schema_missing: 'Cơ sở dữ liệu chưa được cập nhật (thiếu migration).',
  feature_unavailable: 'Tính năng chưa sẵn sàng trên máy chủ (cần cập nhật database).',
  unknown: 'Đã có lỗi xảy ra. Vui lòng thử lại.',
};

export class AppError extends Error {
  /**
   * @param {string} code     stable machine code (see MESSAGES)
   * @param {string} [message] Vietnamese message; defaults to MESSAGES[code]
   * @param {{cause?: unknown, details?: object}} [opts]
   */
  constructor(code, message, { cause, details } = {}) {
    super(message || MESSAGES[code] || MESSAGES.unknown);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
    this.details = details || {};
  }

  /** Compat flag for UI code that redirects to the login screen. */
  get sessionExpired() {
    return this.code === 'session_expired';
  }
}

const BUSINESS_CODES = new Set([
  'timer_already_running',
  'task_closed',
  'time_overlap',
  'not_found',
  'already_purchased',
  'invalid_input',
]);

const PG_CODES = {
  23505: 'duplicate',
  23503: 'invalid_reference',
  23514: 'invalid_input',
  23502: 'invalid_input',
  22001: 'invalid_input',
  '22P02': 'invalid_input',
  '22007': 'invalid_input',
  '22008': 'invalid_input',
  22023: 'invalid_input',
  42501: 'forbidden',
  PGRST301: 'forbidden',
  PGRST116: 'not_found',
  P0002: 'not_found',
  PGRST202: 'feature_unavailable',
  PGRST205: 'schema_missing',
  '42P01': 'schema_missing',
  '42883': 'feature_unavailable',
};

const AUTH_CODES = {
  invalid_credentials: 'invalid_credentials',
  email_not_confirmed: 'email_not_confirmed',
  user_already_exists: 'user_already_exists',
  email_exists: 'user_already_exists',
  weak_password: 'weak_password',
  same_password: 'same_password',
  over_email_send_rate_limit: 'rate_limited',
  over_request_rate_limit: 'rate_limited',
  over_sms_send_rate_limit: 'rate_limited',
  email_address_invalid: 'invalid_email',
  validation_failed: 'invalid_input',
  signup_disabled: 'signup_disabled',
  email_provider_disabled: 'signup_disabled',
  session_expired: 'session_expired',
  session_not_found: 'session_expired',
  refresh_token_not_found: 'session_expired',
  refresh_token_already_used: 'session_expired',
  bad_jwt: 'session_expired',
  flow_state_expired: 'link_expired',
  flow_state_not_found: 'link_expired',
  bad_code_verifier: 'link_expired',
  otp_expired: 'link_expired',
};

const MESSAGE_PATTERNS = [
  [/jwt expired|invalid jwt|auth session missing|refresh token|session (has )?expired/i, 'session_expired'],
  [/invalid login credentials/i, 'invalid_credentials'],
  [/email not confirmed/i, 'email_not_confirmed'],
  [/user already registered|already been registered|already exists/i, 'user_already_exists'],
  [/password should be|weak.?password/i, 'weak_password'],
  [/same.?password|different from the old/i, 'same_password'],
  [/rate limit|too many requests/i, 'rate_limited'],
  [/unable to validate email|invalid email|email address .* is invalid/i, 'invalid_email'],
  [/signups? (are )?not allowed|signup is disabled/i, 'signup_disabled'],
  [/code verifier|link is invalid or has expired/i, 'link_expired'],
];

// Messages the 000200 RPCs raise with SQLSTATE 22023/P0002 (English, not codes).
const SQL_MESSAGE_PATTERNS = [
  [/closed task/i, 'task_closed'],
  [/already purchased/i, 'already_purchased'],
  [/overlap/i, 'time_overlap'],
  [/time_entries_one_running|one_running/i, 'timer_already_running'],
];

function isNetworkError(err, msg) {
  if (err?.name === 'AuthRetryableFetchError') return true;
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(msg)) return true;
  return err instanceof TypeError && /fetch/i.test(msg);
}

/** Map any thrown value / Supabase error object to an AppError. */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err == null) return new AppError('unknown');

  const msg = String(err.message ?? err.error_description ?? (typeof err === 'string' ? err : ''));
  const code = err.code != null ? String(err.code) : '';
  const make = (c, details) => new AppError(c, undefined, { cause: err, details });

  if (isNetworkError(err, msg)) return make('network');

  // RPC business errors: `raise exception using message = '<code>'`.
  const bare = msg.trim();
  if (BUSINESS_CODES.has(bare)) return make(bare);
  if (bare === 'not_authenticated') return make('session_expired');

  // Postgres / PostgREST SQLSTATE.
  if (code && /^(\d{5}|[0-9A-Z]{5}|PGRST\d+)$/.test(code)) {
    for (const [re, c] of SQL_MESSAGE_PATTERNS) {
      if (re.test(msg) || re.test(err.details || '')) return make(c);
    }
    if (/jwt expired/i.test(msg)) return make('session_expired');
    if (PG_CODES[code]) return make(PG_CODES[code]);
  }

  // Supabase Auth (AuthApiError has .code and .status).
  if (code && AUTH_CODES[code]) return make(AUTH_CODES[code]);
  for (const [re, c] of MESSAGE_PATTERNS) if (re.test(msg)) return make(c);
  if (err.status === 429) return make('rate_limited');
  if (err.status === 401) return make('session_expired');

  return make('unknown');
}

/** `{data, error}` → data, or throw the mapped AppError. */
export function unwrap(res) {
  if (!res) throw new AppError('unknown');
  if (res.error) throw toAppError(res.error);
  return res.data;
}

/** Await a Supabase builder/promise and unwrap it (rejections are mapped too). */
export async function run(query) {
  let res;
  try {
    res = await query;
  } catch (e) {
    throw toAppError(e);
  }
  return unwrap(res);
}

/** The configured Supabase client, or AppError('not_configured'). */
export function db() {
  if (!supabase) throw new AppError('not_configured');
  return supabase;
}

/**
 * rpc() that falls back when the function is missing on the server
 * (PostgREST PGRST202 / Postgres 42883 → AppError 'feature_unavailable'),
 * e.g. a newer migration not yet applied to the hosted DB.
 */
export async function rpcOr(name, args, fallback) {
  try {
    return await rpc(name, args);
  } catch (e) {
    if (e?.code === 'feature_unavailable' && fallback) return fallback(e);
    throw e;
  }
}

/** supabase.rpc(name, args) + unwrap. */
export function rpc(name, args) {
  const c = db();
  return run(args === undefined ? c.rpc(name) : c.rpc(name, args));
}

// ---------------------------------------------------------------------------
// Validation helpers (mirror DB CHECK constraints → AppError 'invalid_input')
// ---------------------------------------------------------------------------

export function invalid(field, message) {
  return new AppError('invalid_input', message || MESSAGES.invalid_input, { details: { field } });
}

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/** Copy only whitelisted, defined keys. */
export function pick(input, allowed) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of allowed) if (has(input, k)) out[k] = input[k];
  return out;
}

/** Trim strings; '' → null. Non-strings are returned as-is. */
export function emptyToNull(v) {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function requireId(id, field = 'id') {
  if (typeof id !== 'string' || !id.trim()) throw invalid(field, 'Thiếu mã định danh.');
  return id;
}

export function vText(v, field, { required = false, min = required ? 1 : 0, max, label = 'Nội dung', keepEmpty = false } = {}) {
  let s = v == null ? null : String(v).trim();
  if (s === '' && !keepEmpty) s = null;
  if (s == null) {
    if (required) throw invalid(field, `${label} không được để trống.`);
    return keepEmpty ? '' : null;
  }
  if (s.length < min) throw invalid(field, `${label} quá ngắn.`);
  if (max != null && s.length > max) throw invalid(field, `${label} tối đa ${max} ký tự.`);
  return s;
}

/** Number parsing; '' / null → null (unless required). */
export function vNumber(v, field, { required = false, min, max, gt, integer = false, label = 'Giá trị' } = {}) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw invalid(field, `${label} không được để trống.`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw invalid(field, `${label} phải là số.`);
  if (integer && !Number.isInteger(n)) throw invalid(field, `${label} phải là số nguyên.`);
  if (gt != null && !(n > gt)) throw invalid(field, `${label} phải lớn hơn ${gt}.`);
  if (min != null && n < min) throw invalid(field, `${label} phải ≥ ${min}.`);
  if (max != null && n > max) throw invalid(field, `${label} phải ≤ ${max}.`);
  return n;
}

export function vEnum(v, field, values, { required = false, label = 'Giá trị' } = {}) {
  const s = emptyToNull(v);
  if (s == null) {
    if (required) throw invalid(field, `${label} không được để trống.`);
    return null;
  }
  if (!values.includes(s)) throw invalid(field, `${label} không hợp lệ.`);
  return s;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isDay(s) {
  const m = typeof s === 'string' && DAY_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function vDay(v, field, { required = false, label = 'Ngày' } = {}) {
  const s = emptyToNull(v);
  if (s == null) {
    if (required) throw invalid(field, `${label} không được để trống.`);
    return null;
  }
  if (!isDay(s)) throw invalid(field, `${label} không hợp lệ (YYYY-MM-DD).`);
  return s;
}

/** Instant (Date | ISO string) → ISO string. */
export function vInstant(v, field, { required = false, label = 'Thời điểm' } = {}) {
  if (v == null || v === '') {
    if (required) throw invalid(field, `${label} không được để trống.`);
    return null;
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(field, `${label} không hợp lệ.`);
  return d.toISOString();
}

export function vUrl(v, field, { label = 'Liên kết' } = {}) {
  const s = emptyToNull(v);
  if (s == null) return null;
  if (!/^https?:\/\//i.test(s)) throw invalid(field, `${label} phải bắt đầu bằng http:// hoặc https://`);
  return s;
}

export function vColor(v, field = 'color') {
  const s = emptyToNull(v);
  if (s == null) return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw invalid(field, 'Màu phải có dạng #RRGGBB.');
  return s;
}

export function vUuidOrNull(v, field) {
  const s = emptyToNull(v);
  if (s == null) return null;
  if (typeof s !== 'string') throw invalid(field, 'Mã liên kết không hợp lệ.');
  return s;
}

/** Throw when nothing writable is left after whitelisting (empty UPDATE). */
export function requireNonEmpty(patch) {
  if (!patch || Object.keys(patch).length === 0) throw invalid(null, 'Không có thay đổi nào để lưu.');
  return patch;
}

// ---------------------------------------------------------------------------
// Normalisation (PostgREST may return numeric columns as strings)
// ---------------------------------------------------------------------------

export function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Shallow-convert the given fields of a row (or array of rows) to numbers. */
export function numify(rows, fields) {
  if (rows == null) return rows;
  if (Array.isArray(rows)) return rows.map((r) => numify(r, fields));
  if (typeof rows !== 'object') return rows;
  const out = { ...rows };
  for (const f of fields) if (f in out) out[f] = toNum(out[f]);
  return out;
}

/** RPC returning a single composite row may arrive as [row] or row. */
export function single(d) {
  if (Array.isArray(d)) return d[0] ?? null;
  return d ?? null;
}

/** Escape user text for a LIKE pattern and wrap it as %text%. */
export function likePattern(text) {
  const s = String(text).trim().replace(/[\\%_]/g, (c) => '\\' + c).replace(/\*/g, '_');
  return `%${s}%`;
}

/**
 * Value for a PostgREST logic-tree filter (`.or('a.ilike.<v>,b.ilike.<v>')`):
 * double-quoted so `, . : ( )` are literal; `\` and `"` backslash-escaped.
 */
export function orValue(v) {
  return `"${String(v).replace(/[\\"]/g, (c) => '\\' + c)}"`;
}

/** `.or()` expression matching `text` (ilike, escaped) in any of `columns`. */
export function searchOr(text, columns) {
  const v = orValue(likePattern(text));
  return columns.map((c) => `${c}.ilike.${v}`).join(',');
}
