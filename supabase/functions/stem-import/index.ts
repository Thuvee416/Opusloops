import {
  DispatchError,
  dispatchFailureRpcName,
  fetchAwsBatch,
  requireAwsBatchJson,
} from "./aws-dispatch.mjs";
import { isLegacyStorageAnonKey } from "./storage-credential.mjs";
import { canonicalAssetUuid, canonicalV4Uuid } from "./validation.ts";

const allowedOrigins = new Set([
  "https://opusloops.com",
  "https://www.opusloops.com",
  "https://main.d1zc92wmtmvg23.amplifyapp.com",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:4174",
  "http://localhost:4173",
]);

const MAX_REQUEST_BYTES = 1_100_000;
const UPLOAD_BUCKET = "opusloops-stem-uploads";
const SOURCE_BUCKET = "opusloops-stem-sources";
const ARTIFACT_BUCKET = "opusloops-stem-artifacts";
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function responseHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function json(origin: string, status: number, body: JsonObject) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

async function readLimitedJson(request: Request): Promise<JsonObject> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) throw new ApiError(413, "request_too_large", "Request is too large");
  if (!request.body) throw new ApiError(400, "invalid_request", "A JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "request_too_large", "Request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim() || "";
  if (!value) throw new ApiError(503, "service_unavailable", "Stem import service is not configured");
  return value;
}

function supabaseConfig() {
  const anonKey = requiredEnv("SUPABASE_ANON_KEY");
  const url = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const projectRef = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/.exec(url)?.[1] || "";
  const storageLegacyAnonKey = requiredEnv("OPUSLOOPS_STORAGE_LEGACY_ANON_KEY");
  if (!isLegacyStorageAnonKey(storageLegacyAnonKey, projectRef)) {
    throw new ApiError(503, "service_unavailable", "Stem import service is not configured");
  }
  return {
    url,
    publishableKey: Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || anonKey,
    storageLegacyAnonKey,
    serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function authenticatedUser(
  request: Request,
): Promise<{ id: string; app_metadata: JsonObject; accessToken: string; expiresAt: number }> {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw new ApiError(401, "authentication_required", "Sign in to import stems");
  }
  const accessToken = authorization.slice(7).trim();
  if (!accessToken || accessToken.length > 8192 || /[\r\n]/.test(accessToken)) {
    throw new ApiError(401, "authentication_required", "Your session is no longer valid");
  }
  let expiresAt = 0;
  try {
    const payloadPart = accessToken.split(".")[1];
    const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as JsonObject;
    if (Number.isSafeInteger(claims.exp)) expiresAt = Number(claims.exp);
  } catch {
    throw new ApiError(401, "authentication_required", "Your session is no longer valid");
  }
  const config = supabaseConfig();
  const response = await fetch(`${config.url}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: config.publishableKey,
      authorization,
      "x-client-info": "opusloops-stem-import/1.0",
    },
  });
  const body = await readResponse(response) as JsonObject | null;
  if (!response.ok || !body?.id) {
    throw new ApiError(401, "authentication_required", "Your session is no longer valid");
  }
  const metadata = body.app_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || (metadata as JsonObject).opusloops !== true) {
    throw new ApiError(403, "forbidden", "An Opusloops account is required");
  }
  return { id: String(body.id), app_metadata: metadata as JsonObject, accessToken, expiresAt };
}

function rpcError(status: number, body: unknown): ApiError {
  const record = body && typeof body === "object" ? body as JsonObject : {};
  const message = String(record.message || "Stem import request failed");
  const sqlCode = String(record.code || "");
  if (sqlCode === "P0002") return new ApiError(404, "not_found", message);
  if (sqlCode === "40001") return new ApiError(409, "stale_revision", message);
  if (sqlCode === "55000") return new ApiError(409, "invalid_state", message);
  if (sqlCode === "54000") return new ApiError(409, "processing_capacity_busy", message);
  if (sqlCode === "42501") return new ApiError(403, "forbidden", message);
  if (sqlCode === "22023" || status === 400) return new ApiError(400, "invalid_request", message);
  return new ApiError(503, "service_unavailable", "Stem import service is temporarily unavailable");
}

async function rpc(name: string, body: JsonObject): Promise<unknown> {
  const config = supabaseConfig();
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      "content-type": "application/json",
      "x-client-info": "opusloops-stem-import/1.0",
    },
    body: JSON.stringify(body),
  });
  const result = await readResponse(response);
  if (!response.ok) throw rpcError(response.status, result);
  return result;
}

function stringField(body: JsonObject, name: string, maximum = 1_000_000): string {
  const value = body[name];
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ApiError(400, "invalid_request", `${name} is invalid`);
  }
  return value;
}

function uuidField(body: JsonObject, name: string): string {
  const value = stringField(body, name, 36);
  const canonical = canonicalV4Uuid(value);
  if (!canonical) {
    throw new ApiError(400, "invalid_request", `${name} is invalid`);
  }
  return canonical;
}

function assetUuidField(body: JsonObject, name: string): string {
  const value = stringField(body, name, 36);
  const canonical = canonicalAssetUuid(value);
  if (!canonical) {
    throw new ApiError(400, "invalid_request", `${name} is invalid`);
  }
  return canonical;
}

function revisionField(body: JsonObject): number {
  const revision = body.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
    throw new ApiError(400, "invalid_request", "revision is invalid");
  }
  return Number(revision);
}

function integerField(body: JsonObject, name: string, minimum: number, maximum: number): number {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ApiError(400, "invalid_request", `${name} is invalid`);
  }
  return Number(value);
}

function numberField(body: JsonObject, name: string, minimum: number, maximum: number): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApiError(400, "invalid_request", `${name} is invalid`);
  }
  return value;
}

function objectField(body: JsonObject, name: string): JsonObject {
  const value = body[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", `${name} is invalid`);
  }
  return value as JsonObject;
}

function confirmations(body: JsonObject, names: string[]): boolean[] {
  const value = objectField(body, "confirmations");
  return names.map((name) => value[name] === true);
}

function encodeObjectPath(path: string) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function inspectUploadedObject(bucket: string, objectPath: string): Promise<{ bytes: number; etag: string }> {
  const config = supabaseConfig();
  const response = await fetch(
    `${config.url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodeObjectPath(objectPath)}`,
    {
      method: "HEAD",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "cache-control": "no-store",
      },
    },
  );
  if (response.status === 404) throw new ApiError(409, "upload_incomplete", "Stem archive upload is not complete");
  if (!response.ok) throw new ApiError(503, "storage_unavailable", "Stem archive could not be verified");
  const bytes = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new ApiError(503, "storage_unavailable", "Stem archive size could not be verified");
  }
  return { bytes, etag: (response.headers.get("etag") || "").slice(0, 200) };
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", arrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

async function callbackToken(attemptId: string): Promise<string> {
  const master = requiredEnv("OPUSLOOPS_WORKER_CALLBACK_SECRET");
  if (master.length < 32) {
    throw new ApiError(503, "service_unavailable", "Stem import service is not configured");
  }
  return bytesToHex(await hmac(new TextEncoder().encode(master), attemptId.toLowerCase()));
}

function awsTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function awsBatchRequest(path: string, body: JsonObject): Promise<JsonObject> {
  const region = requiredEnv("OPUSLOOPS_AWS_REGION");
  const accessKey = requiredEnv("OPUSLOOPS_AWS_ACCESS_KEY_ID");
  const secretKey = requiredEnv("OPUSLOOPS_AWS_SECRET_ACCESS_KEY");
  const sessionToken = Deno.env.get("OPUSLOOPS_AWS_SESSION_TOKEN")?.trim() || "";
  const requestBody = JSON.stringify(body);
  const host = `batch.${region}.amazonaws.com`;
  const amzDate = awsTimestamp();
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256(requestBody);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = ["POST", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/batch/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest)].join("\n");
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretKey}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "batch");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = bytesToHex(await hmac(signingKey, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchAwsBatch(fetch, `https://${host}${path}`, {
      method: "POST",
      headers: { ...headers, authorization },
      body: requestBody,
      signal: controller.signal,
    });
    return await requireAwsBatchJson(response) as JsonObject;
  } finally {
    clearTimeout(timeout);
  }
}

async function submitBatchJob(payload: JsonObject, jobName: string): Promise<string> {
  const stage = String(payload.stage || "worker");
  const definitionVariables: Record<string, string> = {
    inspect: "OPUSLOOPS_AWS_BATCH_INSPECT_JOB_DEFINITION",
    analyze: "OPUSLOOPS_AWS_BATCH_ANALYZE_JOB_DEFINITION",
    propose: "OPUSLOOPS_AWS_BATCH_PROPOSE_JOB_DEFINITION",
    render: "OPUSLOOPS_AWS_BATCH_RENDER_JOB_DEFINITION",
  };
  const definitionVariable = definitionVariables[stage];
  if (!definitionVariable) throw new DispatchError(false);
  const result = await awsBatchRequest("/v1/submitjob", {
    jobName,
    jobQueue: requiredEnv("OPUSLOOPS_AWS_BATCH_JOB_QUEUE"),
    jobDefinition: requiredEnv(definitionVariable),
    parameters: { payload_base64: base64Utf8(JSON.stringify(payload)) },
  });
  if (typeof result.jobId !== "string" || !result.jobId) throw new DispatchError(true);
  return result.jobId;
}

async function findBatchJob(jobName: string): Promise<string | null> {
  const result = await awsBatchRequest("/v1/listjobs", {
    jobQueue: requiredEnv("OPUSLOOPS_AWS_BATCH_JOB_QUEUE"),
    filters: [{ name: "JOB_NAME", values: [jobName] }],
    maxResults: 100,
  });
  if (!Array.isArray(result.jobSummaryList)) throw new DispatchError(true);
  const matches = result.jobSummaryList
    .filter((value): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .filter((value) => value.jobName === jobName && typeof value.jobId === "string")
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  return matches.length ? String(matches[0].jobId) : null;
}

async function dispatch(
  userId: string,
  jobId: string,
  userAccessToken: string,
  tokenExpiresAt: number,
): Promise<JsonObject> {
  if (tokenExpiresAt - Math.floor(Date.now() / 1000) < 2700) {
    return { state: "pending", alreadyDispatched: false, reason: "session_refresh_required" };
  }
  const claimId = crypto.randomUUID();
  const claimed = await rpc("claim_stem_dispatch", {
    p_user_id: userId,
    p_job_id: jobId,
    p_claim_id: claimId,
  }) as JsonObject;
  const stage = String(claimed.stage || "");
  const attemptId = String(claimed.attemptId || "");
  if (claimed.alreadyDispatched === true) {
    return { state: "submitted", stage, attemptId, alreadyDispatched: true };
  }
  if (claimed.dispatchClaimed !== true) {
    return { state: "pending", stage, attemptId, alreadyDispatched: false };
  }

  const jobName = String(claimed.dispatchJobName || "");
  let workerPayload: JsonObject;
  try {
    const config = supabaseConfig();
    const refMatch = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(config.url);
    if (!refMatch || !/^[A-Za-z0-9_-]{1,128}$/.test(jobName)) {
      throw new DispatchError(false);
    }
    workerPayload = {
      version: 1,
      jobId: claimed.jobId,
      userId: claimed.userId,
      projectId: claimed.projectId,
      attemptId: claimed.attemptId,
      stage: claimed.stage,
      revision: claimed.revision,
      storage: {
        endpoint: `https://${refMatch[1]}.storage.supabase.co/storage/v1/s3`,
        region: Deno.env.get("OPUSLOOPS_STORAGE_REGION")?.trim() || "us-east-1",
        accessKeyId: refMatch[1],
        secretAccessKey: config.storageLegacyAnonKey,
        sessionToken: userAccessToken,
        uploadBucket: UPLOAD_BUCKET,
        sourceBucket: SOURCE_BUCKET,
        artifactBucket: ARTIFACT_BUCKET,
        sourceKey: claimed.sourceKey,
        runPrefix: claimed.runPrefix,
      },
      inputs: claimed.inputs,
      callback: {
        url: Deno.env.get("OPUSLOOPS_WORKER_CALLBACK_URL")?.trim()
          || `${config.url}/functions/v1/stem-worker-callback`,
        token: await callbackToken(attemptId),
      },
    };
  } catch {
    await rpc("record_stem_dispatch_error", {
      p_attempt_id: attemptId,
      p_claim_id: claimId,
      p_error_message: "Batch submission configuration is unavailable",
    }).catch(() => {});
    return { state: "pending", stage, attemptId, alreadyDispatched: false };
  }

  if (claimed.reconcileRequired === true) {
    try {
      const existingJobId = await findBatchJob(jobName);
      if (existingJobId) {
        try {
          await rpc("record_stem_dispatch", {
            p_attempt_id: attemptId,
            p_claim_id: claimId,
            p_external_job_id: existingJobId,
          });
          return { state: "submitted", stage, attemptId, alreadyDispatched: true };
        } catch {
          return { state: "pending", stage, attemptId, alreadyDispatched: false };
        }
      }
    } catch {
      await rpc("record_stem_dispatch_unknown", {
        p_attempt_id: attemptId,
        p_claim_id: claimId,
      }).catch(() => {});
      return { state: "pending", stage, attemptId, alreadyDispatched: false };
    }
  }

  let externalJobId: string;
  try {
    externalJobId = await submitBatchJob(workerPayload, jobName);
  } catch (error) {
    const rpcName = dispatchFailureRpcName(error);
    const rpcBody: JsonObject = {
      p_attempt_id: attemptId,
      p_claim_id: claimId,
    };
    if (rpcName === "record_stem_dispatch_error") {
      rpcBody.p_error_message = "Batch submission failed; the durable job remains queued";
    }
    await rpc(rpcName, rpcBody).catch(() => {});
    return { state: "pending", stage, attemptId, alreadyDispatched: false };
  }

  try {
    await rpc("record_stem_dispatch", {
      p_attempt_id: attemptId,
      p_claim_id: claimId,
      p_external_job_id: externalJobId,
    });
    return { state: "submitted", stage, attemptId, alreadyDispatched: false };
  } catch {
    return { state: "pending", stage, attemptId, alreadyDispatched: false };
  }
}

async function durableDispatch(
  userId: string,
  jobId: string,
  userAccessToken: string,
  tokenExpiresAt: number,
): Promise<JsonObject> {
  try {
    return await dispatch(userId, jobId, userAccessToken, tokenExpiresAt);
  } catch {
    return { state: "pending", alreadyDispatched: false };
  }
}

async function signedDownload(asset: JsonObject, expiresIn: number) {
  const config = supabaseConfig();
  const bucket = String(asset.bucket || "");
  const path = String(asset.object_path || "");
  const response = await fetch(
    `${config.url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresIn }),
    },
  );
  const result = await readResponse(response) as JsonObject | null;
  if (!response.ok) throw new ApiError(503, "storage_unavailable", "Stem asset could not be signed");
  const relative = String(result?.signedURL || result?.signedUrl || "");
  if (!relative) throw new ApiError(503, "storage_unavailable", "Stem asset could not be signed");
  return relative.startsWith("http") ? relative : `${config.url}/storage/v1${relative.startsWith("/") ? "" : "/"}${relative}`;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  if (!allowedOrigins.has(origin)) {
    return new Response(JSON.stringify({ code: "origin_denied", message: "Stem import is unavailable here" }), {
      status: 403,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
    });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  if (request.method !== "POST") return json(origin, 405, { code: "method_not_allowed", message: "Use POST" });

  try {
    const user = await authenticatedUser(request);
    const body = await readLimitedJson(request);
    const action = stringField(body, "action", 40);
    let job: JsonObject;
    let dispatchResult: JsonObject | null = null;

    if (action === "create") {
      const projectId = uuidField(body, "projectId");
      const file = objectField(body, "file");
      const name = stringField(file, "name", 255);
      const size = file.size;
      if (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > 2_147_483_648) {
        throw new ApiError(400, "invalid_request", "Stem archive size is invalid");
      }
      job = await rpc("create_stem_import", {
        p_user_id: user.id,
        p_project_id: projectId,
        p_source_name: name,
        p_source_bytes: Number(size),
        p_source_content_type: typeof file.type === "string" && file.type ? file.type.slice(0, 127) : "application/zip",
      }) as JsonObject;
      return json(origin, 201, {
        job,
        upload: {
          endpoint: `https://${new URL(supabaseConfig().url).hostname.split(".")[0]}.storage.supabase.co/storage/v1/upload/resumable`,
          bucketName: UPLOAD_BUCKET,
          objectName: job.source_object_path,
          chunkSize: TUS_CHUNK_BYTES,
        },
      });
    }

    const jobId = uuidField(body, "jobId");
    if (action === "finalize-upload") {
      const revision = revisionField(body);
      const current = await rpc("get_stem_job_for_finalize", { p_user_id: user.id, p_job_id: jobId }) as JsonObject;
      const observed = await inspectUploadedObject(String(current.source_bucket), String(current.source_object_path));
      job = await rpc("finalize_stem_upload", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revision,
        p_observed_bytes: observed.bytes, p_storage_etag: observed.etag,
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "retry-inspection") {
      const revision = revisionField(body);
      const current = await rpc("get_stem_inspection_retry_source", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revision,
      }) as JsonObject;
      const observed = await inspectUploadedObject(String(current.source_bucket), String(current.source_object_path));
      job = await rpc("retry_stem_inspection", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revision,
        p_observed_bytes: observed.bytes, p_storage_etag: observed.etag,
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "retry-proposal") {
      job = await rpc("retry_stem_proposal", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revisionField(body),
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "repair-render-proposal") {
      job = await rpc("repair_stem_render_proposal", {
        p_user_id: user.id,
        p_job_id: jobId,
        p_revision: revisionField(body),
        p_proposal_manifest_sha256: stringField(body, "proposalManifestSha256", 64),
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "approve-analysis") {
      const [files, roles, reference, originals] = confirmations(body, [
        "files", "roles", "reference", "originalsUnchanged",
      ]);
      job = await rpc("approve_stem_analysis", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revisionField(body),
        p_inspection_manifest_sha256: stringField(body, "inspectionManifestSha256", 64),
        p_selection: objectField(body, "selection"), p_confirm_files: files,
        p_confirm_roles: roles, p_confirm_reference: reference,
        p_confirm_originals_unchanged: originals,
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "request-proposal") {
      const mode = stringField(body, "mode", 32);
      const targetBpm = mode === "no-conform" ? null : numberField(body, "targetBpm", 20, 400);
      const reviewedGrid = objectField(body, "reviewedGrid");
      const meterDenominator = integerField(body, "meterDenominator", 1, 32);
      if (![1, 2, 4, 8, 16, 32].includes(meterDenominator)) {
        throw new ApiError(400, "invalid_request", "meterDenominator is invalid");
      }
      job = await rpc("request_stem_proposal", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revisionField(body),
        p_analysis_sha256: stringField(body, "analysisSha256", 64),
        p_proposal_id: stringField(body, "proposalId", 64), p_target_bpm: targetBpm,
        p_mode: mode, p_reviewed_grid: reviewedGrid,
        p_meter_numerator: integerField(body, "meterNumerator", 1, 32),
        p_meter_denominator: meterDenominator,
        p_first_downbeat_seconds: numberField(body, "firstDownbeatSeconds", 0, 86_400),
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "approve-tempo") {
      const flags = confirmations(body, [
        "click", "beatGrid", "meterDownbeat", "tempoOctave", "flags", "target",
        "sharedMap", "originalsUnchanged",
      ]);
      job = await rpc("approve_stem_tempo", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revisionField(body),
        p_proposal_manifest_sha256: stringField(body, "proposalManifestSha256", 64),
        p_approval: objectField(body, "approval"), p_confirm_click: flags[0],
        p_confirm_beat_grid: flags[1], p_confirm_meter_downbeat: flags[2],
        p_confirm_tempo_octave: flags[3], p_confirm_flags: flags[4],
        p_confirm_target: flags[5], p_confirm_shared_map: flags[6],
        p_confirm_originals_unchanged: flags[7],
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "dispatch") {
      job = await rpc("get_stem_job_for_dispatch", {
        p_user_id: user.id, p_job_id: jobId,
      }) as JsonObject;
      dispatchResult = await durableDispatch(user.id, jobId, user.accessToken, user.expiresAt);
    } else if (action === "cancel") {
      job = await rpc("cancel_stem_import", {
        p_user_id: user.id, p_job_id: jobId, p_revision: revisionField(body),
      }) as JsonObject;
    } else if (action === "signed-download") {
      const assetId = assetUuidField(body, "assetId");
      const requestedExpiry = Number(body.expiresInSeconds ?? 900);
      const expiresIn = Number.isFinite(requestedExpiry)
        ? Math.max(60, Math.min(3600, Math.floor(requestedExpiry)))
        : 900;
      const asset = await rpc("get_stem_asset_for_signing", {
        p_user_id: user.id, p_job_id: jobId, p_asset_id: assetId,
      }) as JsonObject;
      const signedUrl = await signedDownload(asset, expiresIn);
      return json(origin, 200, {
        asset: {
          id: asset.asset_id, kind: asset.kind, variant: asset.variant,
          contentType: asset.content_type, bytes: asset.bytes, sha256: asset.sha256,
        },
        signedUrl,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      });
    } else {
      throw new ApiError(400, "invalid_request", "Unknown stem import action");
    }
    return json(origin, 200, dispatchResult ? { job, dispatch: dispatchResult } : { job });
  } catch (error) {
    if (error instanceof ApiError) return json(origin, error.status, { code: error.code, message: error.message });
    return json(origin, 503, { code: "service_unavailable", message: "Stem import service is temporarily unavailable" });
  }
});
