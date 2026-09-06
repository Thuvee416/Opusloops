import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AUTH_API_VERSION,
  createOpusloopsAccountHandler,
} from "./handler.mjs";

const ORIGIN = "https://opusloops.com";
const SUPABASE_URL = "https://test.supabase.co";
const PUBLISHABLE_KEY = "test-publishable-key";
const PUBLISHABLE_KEY_HASH = createHash("sha256").update(PUBLISHABLE_KEY).digest("hex");
const INVITE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const EMAIL = "person@example.net";

function signupRequest() {
  return new Request(`${SUPABASE_URL}/functions/v1/create-opusloops-account`, {
    method: "POST",
    headers: {
      "apikey": PUBLISHABLE_KEY,
      "Content-Type": "application/json",
      "Origin": ORIGIN,
    },
    body: JSON.stringify({
      email: EMAIL,
      password: "correct horse battery staple",
      inviteCode: "invite_code_123456789012",
    }),
  });
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scriptedFetch(steps) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const step = steps[calls.length];
    assert.ok(step, `unexpected fetch: ${String(input)}`);
    const call = {
      url: String(input),
      path: new URL(String(input)).pathname,
      method: init.method || "GET",
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    assert.equal(call.path, step.path);
    if (step.error) throw step.error;
    if (step.respond) return step.respond(call);
    return response(step.body, step.status);
  };
  return { calls, fetchImpl };
}

function createHandler(fetchImpl) {
  const environment = new Map([
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key"],
    ["OPUSLOOPS_PUBLISHABLE_KEY_HASH", PUBLISHABLE_KEY_HASH],
  ]);
  return createOpusloopsAccountHandler({
    getEnv: (name) => environment.get(name) || "",
    fetchImpl,
  });
}

function reservationStep() {
  return {
    path: "/rest/v1/rpc/reserve_opusloops_signup_invite",
    body: { inviteId: INVITE_ID, userId: USER_ID },
  };
}

function assertAuthHeaderIsolation(calls) {
  for (const call of calls) {
    const version = call.headers.get("X-Supabase-Api-Version");
    if (call.path.startsWith("/auth/v1/admin/")) {
      assert.equal(version, AUTH_API_VERSION);
    } else {
      assert.equal(version, null, `Auth API version leaked to ${call.path}`);
    }
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for handler state");
}

test("CORS remains restricted to the production allowlist", async () => {
  const fetchImpl = async () => {
    throw new Error("CORS preflight must not call a backend");
  };
  const handler = createHandler(fetchImpl);
  const allowed = await handler(new Request(`${SUPABASE_URL}/functions/v1/create-opusloops-account`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN },
  }));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const denied = await handler(new Request(`${SUPABASE_URL}/functions/v1/create-opusloops-account`, {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.invalid" },
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("modern and legacy validation errors return typed 400 without releasing", async () => {
  for (const errorBody of [
    { code: "weak_password", message: "weak" },
    { code: 422, error_code: "weak_password", msg: "weak" },
    { code: "422", error_code: "validation_failed", msg: "invalid" },
  ]) {
    const script = scriptedFetch([
      reservationStep(),
      { path: "/auth/v1/admin/users", status: 422, body: errorBody },
    ]);
    const result = await createHandler(script.fetchImpl)(signupRequest());
    const payload = await result.json();

    assert.equal(result.status, 400);
    assert.ok(["weak_password", "invalid_account_details"].includes(payload.code));
    assert.equal(script.calls.length, 2);
    assert.equal(script.calls[1].body.id, USER_ID);
    assert.equal("app_metadata" in script.calls[1].body, false);
    assertAuthHeaderIsolation(script.calls);
  }
});

test("new and legacy existing-user errors reconcile only the exact reservation", async () => {
  for (const errorBody of [
    { code: "email_exists" },
    { code: 422, error_code: "user_already_exists" },
  ]) {
    const script = scriptedFetch([
      reservationStep(),
      { path: "/auth/v1/admin/users", status: 422, body: errorBody },
      { path: `/auth/v1/admin/users/${USER_ID}`, body: { id: USER_ID, email: EMAIL.toUpperCase() } },
      { path: "/rest/v1/rpc/complete_opusloops_signup_invite", body: true },
    ]);
    const result = await createHandler(script.fetchImpl)(signupRequest());

    assert.equal(result.status, 201);
    assert.deepEqual(await result.json(), { created: true });
    assert.equal(script.calls.length, 4);
    assertAuthHeaderIsolation(script.calls);
  }
});

test("existing email owned by another ID remains a conflict without release or completion", async () => {
  for (const lookupStep of [
    { path: `/auth/v1/admin/users/${USER_ID}`, status: 404, body: { code: "user_not_found" } },
    { path: `/auth/v1/admin/users/${USER_ID}`, body: { id: USER_ID, email: "other@example.net" } },
  ]) {
    const script = scriptedFetch([
      reservationStep(),
      { path: "/auth/v1/admin/users", status: 422, body: { code: "email_exists" } },
      lookupStep,
    ]);
    const result = await createHandler(script.fetchImpl)(signupRequest());

    assert.equal(result.status, 409);
    assert.equal((await result.json()).code, "account_exists");
    assert.equal(script.calls.length, 3);
    assertAuthHeaderIsolation(script.calls);
  }
});

test("ambiguous Auth failures remain reserved", async () => {
  for (const authStep of [
    { path: "/auth/v1/admin/users", error: new Error("network failure") },
    { path: "/auth/v1/admin/users", status: 500, body: { code: "weak_password" } },
    { path: "/auth/v1/admin/users", status: 422, body: { code: "unexpected_failure" } },
    { path: "/auth/v1/admin/users", status: 401, body: { code: "weak_password" } },
    { path: "/auth/v1/admin/users", status: 429, body: { code: "weak_password" } },
  ]) {
    const script = scriptedFetch([reservationStep(), authStep]);
    const result = await createHandler(script.fetchImpl)(signupRequest());

    assert.equal(result.status, 503);
    assert.equal((await result.json()).code, "signup_unavailable");
    assert.equal(script.calls.length, 2);
    assertAuthHeaderIsolation(script.calls);
  }
});

test("successful creation awaits and retries durable completion before returning 201", async () => {
  let resolveCompletion;
  const completionGate = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const script = scriptedFetch([
    reservationStep(),
    { path: "/auth/v1/admin/users", body: { id: USER_ID, email: EMAIL } },
    { path: "/rest/v1/rpc/complete_opusloops_signup_invite", body: false },
    {
      path: "/rest/v1/rpc/complete_opusloops_signup_invite",
      respond: () => completionGate,
    },
  ]);
  let settled = false;
  const pending = createHandler(script.fetchImpl)(signupRequest()).then((result) => {
    settled = true;
    return result;
  });
  await waitFor(() => script.calls.length === 4);

  assert.equal(script.calls.length, 4);
  assert.equal(settled, false, "handler returned before completion verification finished");
  resolveCompletion(response(true));
  const result = await pending;
  assert.equal(result.status, 201);
  assert.deepEqual(script.calls[3].body, {
    p_invite_id: INVITE_ID,
    p_user_id: USER_ID,
  });
  assertAuthHeaderIsolation(script.calls);
});

test("unverified completion never returns 201", async () => {
  const script = scriptedFetch([
    reservationStep(),
    { path: "/auth/v1/admin/users", body: { id: USER_ID, email: EMAIL } },
    { path: "/rest/v1/rpc/complete_opusloops_signup_invite", body: false },
    { path: "/rest/v1/rpc/complete_opusloops_signup_invite", body: false },
  ]);
  const result = await createHandler(script.fetchImpl)(signupRequest());

  assert.equal(result.status, 503);
  assert.equal(script.calls.length, 4);
  assertAuthHeaderIsolation(script.calls);
});

test("validation reservations remain available for a deterministic retry", async () => {
  const script = scriptedFetch([
    reservationStep(),
    { path: "/auth/v1/admin/users", status: 422, body: { code: "weak_password" } },
  ]);
  const result = await createHandler(script.fetchImpl)(signupRequest());

  assert.equal(result.status, 400);
  assert.equal(script.calls.length, 2);
  assert.equal(script.calls.some((call) => call.path.includes("release_opusloops")), false);
  assertAuthHeaderIsolation(script.calls);
});
