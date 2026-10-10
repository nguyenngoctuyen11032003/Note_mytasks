// Fitora — AI food recognition (Supabase Edge Function, Deno).
// Contract: Fitora/docs/PLAN.md §3.
//
//   POST /functions/v1/fitora-food-ai      (user JWT; verify_jwt = true in config.toml)
//   { "image": "data:image/jpeg;base64,…", "hint"?: string, "mode"?: "photo" | "live" }
//   200 { dishes: AiDish[], is_food: true, notes }
//   4xx/5xx { error: "not_food" | "quota_exceeded" | "bad_request" | "ai_unavailable", message }
//
// Flow: validate payload -> auth.getUser() with the caller's JWT -> consume the daily
// quota via RPC fit_ai_quota_consume (runs as the caller, never service_role)
// -> Claude vision (JSON only) -> extract + sanitize.
//
// Secrets (supabase secrets set …): ANTHROPIC_API_KEY (required),
// FITORA_AI_MODEL (optional), FITORA_AI_DAILY_LIMIT (optional, default 40).
// SUPABASE_URL / SUPABASE_ANON_KEY are injected by the platform.
// Never log the image, the hint or any key.
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  buildAnthropicRequest,
  type ErrorCode,
  extractJson,
  parseRequestBody,
  responseText,
  sanitizeResult,
  supportsDefaultFallback,
} from './lib.ts';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const AI_TIMEOUT_MS = 45_000;
const MAX_BODY_CHARS = 2_200_000; // ~1.5 MB image as base64 + JSON overhead

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*', // the JWT protects the endpoint, not the origin
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

const fail = (status: number, error: ErrorCode, message: string) => json({ error, message }, status);

type AiCall =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; message: string };

async function callClaude(apiKey: string, payload: Record<string, unknown>, model: string): Promise<AiCall> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (supportsDefaultFallback(model)) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    console.error('anthropic fetch failed:', aborted ? 'timeout' : e instanceof Error ? e.name : 'unknown');
    return aborted
      ? { ok: false, status: 503, message: 'Dịch vụ AI phản hồi quá lâu. Vui lòng thử lại.' }
      : { ok: false, status: 502, message: 'Không kết nối được dịch vụ AI. Vui lòng thử lại.' };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Error bodies never echo the image or key; log a short excerpt for diagnosis.
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error('anthropic error', res.status, detail);
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      return { ok: false, status: 503, message: 'Dịch vụ AI đang quá tải. Vui lòng thử lại sau ít phút.' };
    }
    return { ok: false, status: 502, message: 'Không gọi được dịch vụ AI. Vui lòng thử lại.' };
  }

  const msg = await res.json().catch(() => null) as { stop_reason?: string } | null;
  if (!msg) return { ok: false, status: 502, message: 'AI trả về dữ liệu không hợp lệ. Vui lòng thử lại.' };
  if (msg.stop_reason === 'refusal') {
    console.error('anthropic stop_reason refusal');
    return { ok: false, status: 502, message: 'AI không phân tích được ảnh này. Hãy thử chụp lại rõ hơn.' };
  }
  const value = extractJson(responseText(msg));
  if (!value) {
    console.error('anthropic returned unparsable output, stop_reason =', msg.stop_reason);
    return { ok: false, status: 502, message: 'AI trả về dữ liệu không hợp lệ. Vui lòng thử lại.' };
  }
  return { ok: true, value };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'bad_request', 'Chỉ hỗ trợ phương thức POST.');

  // ---- payload
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_CHARS) return fail(400, 'bad_request', 'Ảnh quá lớn. Vui lòng nén hoặc chọn ảnh nhỏ hơn.');
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return fail(400, 'bad_request', 'Không đọc được dữ liệu gửi lên.');
  }
  if (raw.length > MAX_BODY_CHARS) return fail(400, 'bad_request', 'Ảnh quá lớn. Vui lòng nén hoặc chọn ảnh nhỏ hơn.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'bad_request', 'Dữ liệu gửi lên không phải JSON hợp lệ.');
  }
  const parsed = parseRequestBody(body);
  if (!parsed.ok) return fail(400, 'bad_request', parsed.message);

  // ---- environment (checked before consuming quota so a misconfig never burns a scan)
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!apiKey || !supabaseUrl || !anonKey) {
    console.error('missing env', { anthropic: !!apiKey, url: !!supabaseUrl, anon: !!anonKey });
    return fail(503, 'ai_unavailable', 'Tính năng AI chưa được cấu hình. Vui lòng thử lại sau.');
  }

  // ---- auth (client carries the caller's JWT)
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(authHeader)) {
    return fail(401, 'bad_request', 'Bạn cần đăng nhập để dùng tính năng này.');
  }
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return fail(401, 'bad_request', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.');
  }

  // ---- daily quota
  const envLimit = Number(Deno.env.get('FITORA_AI_DAILY_LIMIT') ?? 40);
  const limit = Number.isFinite(envLimit) && envLimit > 0 ? Math.floor(envLimit) : 40;
  const { data: allowed, error: quotaError } = await supabase.rpc('fit_ai_quota_consume', { p_limit: limit });
  if (quotaError) {
    console.error('quota rpc failed', quotaError.code);
    return fail(503, 'ai_unavailable', 'Không kiểm tra được hạn mức AI. Vui lòng thử lại.');
  }
  if (allowed !== true) {
    return fail(429, 'quota_exceeded',
      `Bạn đã dùng hết ${limit} lượt phân tích AI hôm nay. Hãy quay lại vào ngày mai hoặc nhập món thủ công.`);
  }

  // ---- AI
  const model = (Deno.env.get('FITORA_AI_MODEL') ?? '').trim() || DEFAULT_MODEL;
  const payload = buildAnthropicRequest({
    model, mediaType: parsed.mediaType, data: parsed.data, hint: parsed.hint, mode: parsed.mode,
  });
  const ai = await callClaude(apiKey, payload, model);
  if (!ai.ok) return fail(ai.status, 'ai_unavailable', ai.message);

  const result = sanitizeResult(ai.value);
  if (!result.is_food) {
    return fail(422, 'not_food',
      result.notes || 'Không nhận diện được món ăn trong ảnh. Hãy chụp gần và rõ hơn.');
  }
  return json({ dishes: result.dishes, is_food: true, notes: result.notes });
});
