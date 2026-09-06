import {
  classifyAuthCreateFailure,
  extractAuthErrorCode,
  isAccountExistsAuthCode,
  verifyBooleanOperation,
} from "./policy.mjs";

export const AUTH_API_VERSION = "2024-01-01";

export const ALLOWED_ORIGINS = new Set([
  "https://opusloops.com",
  "https://www.opusloops.com",
  "https://main.d1zc92wmtmvg23.amplifyapp.com",
  "https://heryvahetgzfalmuprbw.supabase.co",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:4174",
  "http://localhost:4173",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function responseHeaders(origin) {
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

function json(origin, status, body) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

function unavailable(origin) {
  return json(origin, 503, {
    code: "signup_unavailable",
    message: "Account creation is temporarily unavailable",
  });
}

function conflict(origin) {
  return json(origin, 409, {
    code: "account_exists",
    message: "An account already uses this email",
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function readLimitedText(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
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

function normalizedUser(responseBody) {
  const user = responseBody?.user || responseBody;
  return {
    id: typeof user?.id === "string" ? user.id : "",
    email: typeof user?.email === "string" ? user.email.trim().toLowerCase() : "",
  };
}

export function createOpusloopsAccountHandler({
  getEnv,
  fetchImpl = globalThis.fetch,
  allowedOrigins = ALLOWED_ORIGINS,
}) {
  if (typeof getEnv !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("Account handler requires environment and fetch adapters");
  }

  function serviceCredentials() {
    const supabaseUrl = getEnv("SUPABASE_URL") || "";
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRoleKey) throw new Error("service_unavailable");
    return { supabaseUrl, serviceRoleKey };
  }

  async function serviceRpc(path, body) {
    const { supabaseUrl, serviceRoleKey } = serviceCredentials();
    return fetchImpl(`${supabaseUrl}${path}`, {
      method: "POST",
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function authAdminRequest(path, { method = "GET", body } = {}) {
    const { supabaseUrl, serviceRoleKey } = serviceCredentials();
    const init = {
      method,
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "X-Supabase-Api-Version": AUTH_API_VERSION,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetchImpl(`${supabaseUrl}/auth/v1/admin${path}`, init);
  }

  async function booleanServiceRpc(path, body) {
    const response = await serviceRpc(path, body);
    if (!response.ok) return false;
    return await response.json().catch(() => false) === true;
  }

  async function completeReservation(inviteId, userId) {
    return verifyBooleanOperation(
      () => booleanServiceRpc("/rest/v1/rpc/complete_opusloops_signup_invite", {
        p_invite_id: inviteId,
        p_user_id: userId,
      }),
      2,
    );
  }

  async function reconcileReservedUser(origin, inviteId, userId, email, mismatchResponse) {
    let lookupResponse;
    try {
      lookupResponse = await authAdminRequest(`/users/${encodeURIComponent(userId)}`);
    } catch {
      return unavailable(origin);
    }
    if (!lookupResponse.ok) {
      return lookupResponse.status === 404 ? mismatchResponse(origin) : unavailable(origin);
    }
    const existing = normalizedUser(await lookupResponse.json().catch(() => null));
    if (existing.id !== userId || existing.email !== email) return mismatchResponse(origin);
    if (!await completeReservation(inviteId, userId)) return unavailable(origin);
    return json(origin, 201, { created: true });
  }

  return async function handleCreateOpusloopsAccount(request) {
    const origin = request.headers.get("origin") || "";
    if (!allowedOrigins.has(origin)) {
      return new Response(JSON.stringify({
        code: "origin_denied",
        message: "Account creation is unavailable here",
      }), {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: responseHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json(origin, 405, { code: "method_not_allowed", message: "Use POST" });
    }

    const expectedKeyHash = getEnv("OPUSLOOPS_PUBLISHABLE_KEY_HASH") || "";
    const suppliedKeyHash = await sha256(request.headers.get("apikey") || "");
    if (!expectedKeyHash || !constantTimeEqual(suppliedKeyHash, expectedKeyHash)) {
      return json(origin, 401, { code: "invalid_api_key", message: "Account creation is unavailable" });
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 4096) {
      return json(origin, 413, { code: "request_too_large", message: "Request is too large" });
    }

    let body;
    try {
      const rawBody = await readLimitedText(request, 4096);
      body = JSON.parse(rawBody);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
    } catch (error) {
      if (error instanceof Error && error.message === "request_too_large") {
        return json(origin, 413, { code: "request_too_large", message: "Request is too large" });
      }
      return json(origin, 400, {
        code: "invalid_request",
        message: "Enter an email, password, and invitation",
      });
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
      return json(origin, 400, {
        code: "invalid_request",
        message: "Enter a valid email, password, and invitation",
      });
    }

    const tokenHash = await sha256(inviteCode);
    let reservation;
    try {
      const reserveResponse = await serviceRpc("/rest/v1/rpc/reserve_opusloops_signup_invite", {
        p_token_hash: tokenHash,
        p_email: email,
      });
      if (!reserveResponse.ok) throw new Error("reserve_failed");
      reservation = await reserveResponse.json();
    } catch {
      return unavailable(origin);
    }
    const inviteId = typeof reservation?.inviteId === "string" ? reservation.inviteId : "";
    const userId = typeof reservation?.userId === "string" ? reservation.userId : "";
    if (!inviteId && !userId) {
      return json(origin, 403, {
        code: "invite_invalid",
        message: "That invitation is invalid, expired, or already used",
      });
    }
    if (!UUID_PATTERN.test(inviteId) || !UUID_PATTERN.test(userId)) return unavailable(origin);

    let adminResponse;
    try {
      adminResponse = await authAdminRequest("/users", {
        method: "POST",
        body: {
          id: userId,
          email,
          password,
          email_confirm: true,
        },
      });
    } catch {
      return unavailable(origin);
    }

    if (!adminResponse.ok) {
      const errorBody = await adminResponse.json().catch(() => ({}));
      const errorCode = extractAuthErrorCode(errorBody);
      if (isAccountExistsAuthCode(errorCode)) {
        return reconcileReservedUser(origin, inviteId, userId, email, conflict);
      }
      const failure = classifyAuthCreateFailure(adminResponse.status, errorCode);
      return json(origin, failure.status, failure.body);
    }

    const created = normalizedUser(await adminResponse.json().catch(() => null));
    if (created.id !== userId) {
      return reconcileReservedUser(origin, inviteId, userId, email, unavailable);
    }
    if (!await completeReservation(inviteId, userId)) return unavailable(origin);
    return json(origin, 201, { created: true });
  };
}
