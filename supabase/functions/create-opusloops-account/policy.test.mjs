import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAuthCreateFailure,
  extractAuthErrorCode,
  isAccountExistsAuthCode,
  verifyBooleanOperation,
} from "./policy.mjs";

test("Auth error extraction supports versioned and legacy response shapes", () => {
  assert.equal(extractAuthErrorCode({ code: "weak_password" }), "weak_password");
  assert.equal(extractAuthErrorCode({ code: 422, error_code: "validation_failed" }), "validation_failed");
  assert.equal(extractAuthErrorCode({ code: "422", error_code: "email_exists" }), "email_exists");
  assert.equal(extractAuthErrorCode({ code: "email_exists", error_code: "legacy_other" }), "email_exists");
  assert.equal(extractAuthErrorCode(null), "");
  assert.equal(isAccountExistsAuthCode(" USER_ALREADY_EXISTS "), true);
});

test("existing-account codes are conflicts and never release the reservation", () => {
  for (const code of ["email_exists", "user_already_exists", " EMAIL_EXISTS "]) {
    assert.deepEqual(classifyAuthCreateFailure(422, code), {
      status: 409,
      body: {
        code: "account_exists",
        message: "An account already uses this email",
      },
    });
  }
});

test("definitive validation failures are typed 400s while reservations persist", () => {
  assert.deepEqual(classifyAuthCreateFailure(422, "weak_password"), {
    status: 400,
    body: { code: "weak_password", message: "Choose a stronger password" },
  });

  for (const code of ["validation_failed", "email_address_invalid"]) {
    const policy = classifyAuthCreateFailure(422, code);
    assert.equal(policy.status, 400);
    assert.equal(policy.body.code, "invalid_account_details");
  }
});

test("5xx, unknown 422, and lookalike codes remain reserved and retryable", () => {
  for (const [status, code] of [
    [500, "weak_password"],
    [503, "validation_failed"],
    [422, "unexpected_failure"],
    [422, "identity_already_exists"],
    [401, "weak_password"],
    [429, "weak_password"],
    [429, "over_request_rate_limit"],
  ]) {
    const policy = classifyAuthCreateFailure(status, code);
    assert.equal(policy.status, 503);
    assert.equal(policy.body.code, "signup_unavailable");
  }
});

test("boolean verification retries once and stops after a verified success", async () => {
  let calls = 0;
  assert.equal(await verifyBooleanOperation(async () => {
    calls += 1;
    return calls === 2;
  }, 2), true);
  assert.equal(calls, 2);

  calls = 0;
  assert.equal(await verifyBooleanOperation(async () => {
    calls += 1;
    return true;
  }, 2), true);
  assert.equal(calls, 1);
});

test("failed and thrown boolean operations cannot be mistaken for success", async () => {
  let calls = 0;
  assert.equal(await verifyBooleanOperation(async () => {
    calls += 1;
    if (calls === 1) throw new Error("ambiguous network failure");
    return false;
  }, 2), false);
  assert.equal(calls, 2);
});
