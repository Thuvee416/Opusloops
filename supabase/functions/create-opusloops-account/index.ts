const allowedOrigins = new Set([
  "https://opusloops.com",
  "https://www.opusloops.com",
  "https://main.d1zc92wmtmvg23.amplifyapp.com",
  "https://heryvahetgzfalmuprbw.supabase.co",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:4174",
  "http://localhost:4173",
]);

function responseHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function json(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function readLimitedText(request: Request, limit: number) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("request_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function serviceRequest(path: string, body: Record<string, unknown>) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) throw new Error("service_unavailable");
  return fetch(`${supabaseUrl}${path}`, {
    method: "POST",
    headers: {
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  if (!allowedOrigins.has(origin)) {
    return new Response(JSON.stringify({ code: "origin_denied", message: "Account creation is unavailable here" }), {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  if (request.method !== "POST") return json(origin, 405, { code: "method_not_allowed", message: "Use POST" });

  const expectedKeyHash = Deno.env.get("OPUSLOOPS_PUBLISHABLE_KEY_HASH") || "";
  const suppliedKeyHash = await sha256(request.headers.get("apikey") || "");
  if (!expectedKeyHash || !constantTimeEqual(suppliedKeyHash, expectedKeyHash)) {
    return json(origin, 401, { code: "invalid_api_key", message: "Account creation is unavailable" });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 4096) return json(origin, 413, { code: "request_too_large", message: "Request is too large" });

  let body: { email?: unknown; password?: unknown; inviteCode?: unknown };
  try {
    const rawBody = await readLimitedText(request, 4096);
    body = JSON.parse(rawBody);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
  } catch (error) {
    if (error instanceof Error && error.message === "request_too_large") {
      return json(origin, 413, { code: "request_too_large", message: "Request is too large" });
    }
    return json(origin, 400, { code: "invalid_request", message: "Enter an email, password, and invitation" });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const inviteCode = String(body.inviteCode || "").trim();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invitePattern = /^[A-Za-z0-9_-]{22,64}$/;
  if (!emailPattern.test(email)
      || email.length > 254
      || password.length < 8
      || password.length > 128
      || !invitePattern.test(inviteCode)) {
    return json(origin, 400, { code: "invalid_request", message: "Enter a valid email, password, and invitation" });
  }

  const tokenHash = await sha256(inviteCode);
  let inviteId: string | null = null;
  try {
    const claimResponse = await serviceRequest("/rest/v1/rpc/claim_opusloops_signup_invite", {
      p_token_hash: tokenHash,
      p_email: email,
    });
    if (!claimResponse.ok) throw new Error("claim_failed");
    inviteId = await claimResponse.json();
  } catch {
    return json(origin, 503, { code: "signup_unavailable", message: "Account creation is temporarily unavailable" });
  }
  if (!inviteId) {
    return json(origin, 403, { code: "invite_invalid", message: "That invitation is invalid, expired, or already used" });
  }

  let adminResponse: Response;
  try {
    adminResponse = await serviceRequest("/auth/v1/admin/users", {
      email,
      password,
      email_confirm: true,
      app_metadata: { opusloops: true },
    });
  } catch {
    return json(origin, 503, { code: "signup_unavailable", message: "Account creation is temporarily unavailable" });
  }

  if (!adminResponse.ok) {
    const errorBody = await adminResponse.json().catch(() => ({}));
    const errorCode = String(errorBody?.code || "");
    if (adminResponse.status === 422 || errorCode.includes("exists")) {
      return json(origin, 409, { code: "account_exists", message: "An account already uses this email" });
    }
    return json(origin, 503, { code: "signup_unavailable", message: "Account creation is temporarily unavailable" });
  }

  const created = await adminResponse.json().catch(() => null);
  const userId = String(created?.id || created?.user?.id || "");
  if (userId) {
    serviceRequest("/rest/v1/rpc/complete_opusloops_signup_invite", {
      p_invite_id: inviteId,
      p_user_id: userId,
    }).catch(() => {});
  }

  return json(origin, 201, { created: true });
});
