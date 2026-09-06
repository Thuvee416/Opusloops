import assert from "node:assert/strict";
import test from "node:test";

import {
  DispatchError,
  dispatchFailureRpcName,
  fetchAwsBatch,
  isAmbiguousAwsBatchStatus,
  requireAwsBatchJson,
} from "./aws-dispatch.mjs";

function assertDispatchError(ambiguous) {
  return (error) => {
    assert.ok(error instanceof DispatchError);
    assert.equal(error.ambiguous, ambiguous);
    return true;
  };
}

test("network failures are ambiguous because Batch may have accepted SubmitJob", async () => {
  await assert.rejects(
    fetchAwsBatch(
      async () => {
        throw new Error("connection reset after request write");
      },
      "https://batch.us-east-1.amazonaws.com/v1/submitjob",
      { method: "POST" },
    ),
    assertDispatchError(true),
  );
});

test("timeouts, throttling, and server failures are ambiguous", async () => {
  for (const status of [408, 429, 500, 502, 503, 599]) {
    assert.equal(isAmbiguousAwsBatchStatus(status), true);
    await assert.rejects(
      requireAwsBatchJson(new Response("not inspected", { status })),
      assertDispatchError(true),
    );
  }
});

test("deterministic client failures stay on the direct error path", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isAmbiguousAwsBatchStatus(status), false);
    await assert.rejects(
      requireAwsBatchJson(new Response("not inspected", { status })),
      assertDispatchError(false),
    );
  }
});

test("only ambiguous dispatch failures enter durable ListJobs reconciliation", () => {
  assert.equal(
    dispatchFailureRpcName(new DispatchError(true)),
    "record_stem_dispatch_unknown",
  );
  assert.equal(
    dispatchFailureRpcName(new DispatchError(false)),
    "record_stem_dispatch_error",
  );
  assert.equal(
    dispatchFailureRpcName(new Error("local validation failure")),
    "record_stem_dispatch_error",
  );
});

test("successful responses require a readable JSON object", async () => {
  const result = await requireAwsBatchJson(
    new Response('{"jobId":"accepted-job"}', { status: 200 }),
  );
  assert.deepEqual(result, { jobId: "accepted-job" });

  for (const body of ["", "not-json", "[]", "null"]) {
    await assert.rejects(
      requireAwsBatchJson(new Response(body, { status: 200 })),
      assertDispatchError(true),
    );
  }
});

test("a response-body transport failure is ambiguous", async () => {
  const response = {
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("response stream reset");
    },
  };
  await assert.rejects(requireAwsBatchJson(response), assertDispatchError(true));
});
