const MAX_REQUEST_BYTES = 2048;
const MAX_BATCH = 50;
const DEFAULT_BATCH = 25;
const DELETE_CONCURRENCY = 4;
const ALLOWED_BUCKETS = new Set([
  "opusloops-stem-uploads",
  "opusloops-stem-sources",
  "opusloops-stem-artifacts",
]);

type JsonObject = Record<string, unknown>;

class MaintenanceError extends Error {
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
  if (!value) throw new MaintenanceError(503, "service_unavailable", "Retention service is not configured");
  return value;
}

function config() {
  return {
    url: requiredEnv("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer(new TextEncoder().encode(value))));
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

async function authorize(request: Request) {
  const expected = requiredEnv("OPUSLOOPS_RETENTION_MAINTENANCE_SECRET");
  if (expected.length < 32) {
    throw new MaintenanceError(503, "service_unavailable", "Retention service is not configured");
  }
  const supplied = request.headers.get("x-opusloops-maintenance-secret")?.trim() || "";
  if (!supplied || supplied.length > 256 || !(await secureEqual(supplied, expected))) {
    throw new MaintenanceError(401, "unauthorized", "Maintenance authorization failed");
  }
}

async function readOptions(request: Request): Promise<{ limit: number }> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) {
    throw new MaintenanceError(413, "request_too_large", "Maintenance request is too large");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new MaintenanceError(413, "request_too_large", "Maintenance request is too large");
  }
  let body: JsonObject = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      body = parsed as JsonObject;
    } catch {
      throw new MaintenanceError(400, "invalid_request", "Maintenance body must be a JSON object");
    }
  }
  const value = body.limit ?? DEFAULT_BATCH;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_BATCH) {
    throw new MaintenanceError(400, "invalid_request", "Retention batch limit is invalid");
  }
  return { limit: Number(value) };
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rpc(name: string, body: JsonObject): Promise<unknown> {
  const settings = config();
  const response = await fetch(`${settings.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: settings.serviceRoleKey,
      authorization: `Bearer ${settings.serviceRoleKey}`,
      "content-type": "application/json",
      "x-client-info": "opusloops-stem-retention/1.0",
    },
    body: JSON.stringify(body),
  });
  const result = await readResponse(response);
  if (!response.ok) {
    throw new MaintenanceError(503, "service_unavailable", "Retention state could not be updated");
  }
  return result;
}

function retentionItem(value: unknown): { itemId: string; bucket: string; objectPath: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MaintenanceError(503, "service_unavailable", "Retention claim is invalid");
  }
  const item = value as JsonObject;
  const itemId = String(item.itemId || "");
  const bucket = String(item.bucket || "");
  const objectPath = String(item.objectPath || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(itemId)
      || !ALLOWED_BUCKETS.has(bucket)
      || objectPath.length < 10 || objectPath.length > 1024
      || objectPath.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(objectPath)
      || /[\u0000-\u001f\u007f]/.test(objectPath)) {
    throw new MaintenanceError(503, "service_unavailable", "Retention claim is invalid");
  }
  return { itemId: itemId.toLowerCase(), bucket, objectPath };
}

async function deleteObject(bucket: string, objectPath: string) {
  const settings = config();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${settings.url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: "DELETE",
      headers: {
        apikey: settings.serviceRoleKey,
        authorization: `Bearer ${settings.serviceRoleKey}`,
        "content-type": "application/json",
        "x-client-info": "opusloops-stem-retention/1.0",
      },
      body: JSON.stringify({ prefixes: [objectPath] }),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error("delete failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function processItem(claimId: string, rawItem: unknown): Promise<boolean> {
  let item: { itemId: string; bucket: string; objectPath: string } | null = null;
  try {
    item = retentionItem(rawItem);
    await deleteObject(item.bucket, item.objectPath);
    await rpc("complete_stem_retention_item", {
      p_claim_id: claimId,
      p_item_id: item.itemId,
    });
    return true;
  } catch {
    if (item) {
      await rpc("fail_stem_retention_item", {
        p_claim_id: claimId,
        p_item_id: item.itemId,
        p_error: "Storage deletion or finalization failed",
      }).catch(() => {});
    }
    return false;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, { code: "method_not_allowed", message: "Use POST" });
  }
  try {
    await authorize(request);
    const { limit } = await readOptions(request);
    const claimId = crypto.randomUUID();
    const claim = await rpc("claim_stem_retention", {
      p_claim_id: claimId,
      p_limit: limit,
    }) as JsonObject;
    const items = Array.isArray(claim.items) ? claim.items : [];
    let cursor = 0;
    let deleted = 0;
    let failed = 0;
    const workers = Array.from(
      { length: Math.min(DELETE_CONCURRENCY, items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor++;
          if (await processItem(claimId, items[index])) deleted += 1;
          else failed += 1;
        }
      },
    );
    await Promise.all(workers);
    return json(200, {
      claimed: items.length,
      deleted,
      failed,
      remaining: Number.isSafeInteger(claim.remaining) ? Number(claim.remaining) : 0,
    });
  } catch (error) {
    if (error instanceof MaintenanceError) {
      return json(error.status, { code: error.code, message: error.message });
    }
    return json(503, { code: "service_unavailable", message: "Retention service is temporarily unavailable" });
  }
});
