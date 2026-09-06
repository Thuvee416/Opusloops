import assert from "node:assert/strict";
import test from "node:test";

import { isLegacyStorageAnonKey } from "./storage-credential.mjs";

const projectRef = "heryvahetgzfalmuprbw";

function credential(claims) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "HS256", typ: "JWT" })}.${segment(claims)}.${"a".repeat(43)}`;
}

const legacyAnonJwt = credential({ iss: "supabase", ref: projectRef, role: "anon" });

test("accepts a legacy JWT-shaped Supabase anon credential", () => {
  assert.equal(isLegacyStorageAnonKey(legacyAnonJwt, projectRef), true);
});

test("rejects a new publishable key because Supabase S3 session auth requires the legacy JWT", () => {
  assert.equal(
    isLegacyStorageAnonKey("sb_publishable_0123456789abcdefghijklmnopqrstuvwxyz", projectRef),
    false,
  );
});

test("rejects privileged and cross-project legacy JWT credentials", () => {
  assert.equal(
    isLegacyStorageAnonKey(credential({ ref: projectRef, role: "service_role" }), projectRef),
    false,
  );
  assert.equal(
    isLegacyStorageAnonKey(
      credential({ ref: "aaaaaaaaaaaaaaaaaaaa", role: "anon" }),
      projectRef,
    ),
    false,
  );
});

test("rejects malformed or unsafe credential shapes", () => {
  for (const value of [null, "", "one.two", "one.two.three\n", "a.b.c"]) {
    assert.equal(isLegacyStorageAnonKey(value, projectRef), false);
  }
  assert.equal(isLegacyStorageAnonKey(legacyAnonJwt, "not-a-project-ref"), false);
});
