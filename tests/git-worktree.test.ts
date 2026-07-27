import assert from "node:assert/strict";
import { test } from "node:test";

const { workerBranchName } = await import("../src/git-worktree.js");

test("workerBranchName slugifies worker names", () => {
  assert.equal(workerBranchName("sdk-worker-1", 2), "fleet/sdk-worker-1-2");
  assert.match(workerBranchName("worker dedicated!", 1), /^fleet\//);
});
