import assert from "node:assert/strict";
import { test } from "node:test";

import { assertLocalAgentId, describeError } from "../src/errors.js";

test("describeError formats Error with metadata", () => {
  const error = new Error("boom") as Error & {
    code: string;
    status: number;
    requestId: string;
    helpUrl: string;
  };
  error.code = "ERR_TEST";
  error.status = 500;
  error.requestId = "req-1";
  error.helpUrl = "https://example.com/help";

  assert.equal(
    describeError(error),
    "boom (code=ERR_TEST, status=500, requestId=req-1, helpUrl=https://example.com/help)",
  );
});

test("describeError returns plain Error message", () => {
  assert.equal(describeError(new Error("plain")), "plain");
});

test("describeError stringifies non-errors", () => {
  assert.equal(describeError("bad"), "bad");
  assert.equal(describeError(null), "null");
});

test("assertLocalAgentId rejects cloud agent ids", () => {
  assert.throws(
    () => assertLocalAgentId("bc-123"),
    /Cloud agent IDs \(bc-\*\) are not supported/,
  );
});

test("assertLocalAgentId allows local agent ids", () => {
  assert.doesNotThrow(() => assertLocalAgentId("agent-local-1"));
});
