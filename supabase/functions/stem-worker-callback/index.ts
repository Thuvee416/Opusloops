const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;

type JsonObject = Record<string, unknown>;

class CallbackError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function json(status: number, body: JsonObject) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim() || "";
  if (!value) throw new CallbackError(503, "service_unavailable", "Worker callback is not configured");
  return value;
}

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) throw new CallbackError(413, "request_too_large", "Request is too large");
  if (!request.body) throw new CallbackError(400, "invalid_request", "A callback body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new CallbackError(413, "request_too_large", "Request is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(bytes: Uint8Array) {
  return hex(await crypto.subtle.digest("SHA-256", arrayBuffer(bytes)));
}

async function signature(secret: string, value: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, arrayBuffer(value)));
}

function header(request: Request, name: string, maximum: number) {
  const value = request.headers.get(name)?.trim() || "";
  if (!value || value.length > maximum) throw new CallbackError(401, "invalid_signature", "Worker signature is invalid");
  return value;
}

function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function rpc(body: JsonObject) {
  const url = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${url}/rest/v1/rpc/apply_stem_worker_callback`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      "x-client-info": "opusloops-stem-worker-callback/1.0",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result: unknown = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }
  if (!response.ok) {
    const record = result && typeof result === "object" ? result as JsonObject : {};
    const sqlCode = String(record.code || "");
    if (sqlCode === "P0002") throw new CallbackError(404, "not_found", "Worker job was not found");
    if (sqlCode === "23505") throw new CallbackError(409, "replay_rejected", "Worker callback replay was rejected");
    if (sqlCode === "55000") throw new CallbackError(409, "stale_attempt", "Worker attempt is no longer active");
    if (sqlCode === "22023") throw new CallbackError(400, "invalid_event", "Worker event was rejected");
    throw new CallbackError(503, "service_unavailable", "Worker callback could not be recorded");
  }
  return result as JsonObject;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(405, { code: "method_not_allowed", message: "Use POST" });
  try {
    const jobId = header(request, "x-opusloops-job-id", 36).toLowerCase();
    const nonce = header(request, "x-opusloops-nonce", 36).toLowerCase();
    const timestampText = header(request, "x-opusloops-timestamp", 16);
    const attemptId = header(request, "x-opusloops-attempt", 36).toLowerCase();
    const suppliedSignature = header(request, "x-opusloops-signature", 64).toLowerCase();
    if (!uuid(jobId) || !uuid(nonce) || !uuid(attemptId) || !/^[0-9a-f]{64}$/.test(suppliedSignature)) {
      throw new CallbackError(401, "invalid_signature", "Worker signature is invalid");
    }
    const timestamp = Number(timestampText);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
      throw new CallbackError(401, "expired_signature", "Worker signature has expired");
    }
    const bodyBytes = await readLimitedBody(request);
    const prefix = new TextEncoder().encode(`${timestampText}.${nonce}.`);
    const signedBytes = new Uint8Array(prefix.length + bodyBytes.length);
    signedBytes.set(prefix, 0);
    signedBytes.set(bodyBytes, prefix.length);
    const callbackMaster = requiredEnv("OPUSLOOPS_WORKER_CALLBACK_SECRET");
    if (callbackMaster.length < 32) {
      throw new CallbackError(503, "service_unavailable", "Worker callback is not configured");
    }
    const attemptToken = await signature(callbackMaster, new TextEncoder().encode(attemptId));
    const expectedSignature = await signature(attemptToken, signedBytes);
    if (!constantTimeEqual(expectedSignature, suppliedSignature)) {
      throw new CallbackError(401, "invalid_signature", "Worker signature is invalid");
    }

    let payload: JsonObject;
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      payload = parsed;
    } catch {
      throw new CallbackError(400, "invalid_request", "Callback body must be a JSON object");
    }
    if (String(payload.jobId || "").toLowerCase() !== jobId
        || String(payload.attemptId || "").toLowerCase() !== attemptId) {
      throw new CallbackError(401, "invalid_signature", "Worker header binding is invalid");
    }
    const response = await rpc({
      p_nonce: nonce,
      p_request_sha256: await sha256(bodyBytes),
      p_payload: payload,
    });
    return json(200, response);
  } catch (error) {
    if (error instanceof CallbackError) return json(error.status, { code: error.code, message: error.message });
    return json(503, { code: "service_unavailable", message: "Worker callback is temporarily unavailable" });
  }
});
