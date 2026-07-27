import assert from "node:assert/strict";
import { test } from "node:test";

const { parseNodeTestSummary, parseShortstat, describeTickOutcome } = await import("../src/tick-outcome.js");

test("parseShortstat extracts file and line counts", () => {
  const stat = parseShortstat("3 files changed, 40 insertions(+), 2 deletions(-)");
  assert.deepEqual(stat, { filesChanged: 3, insertions: 40, deletions: 2 });
});

test("parseNodeTestSummary reads node --test counters", () => {
  const output = "# tests 205\n# pass 204\n# fail 1\n";
  assert.deepEqual(parseNodeTestSummary(output), { total: 205, failed: 1 });
});

test("describeTickOutcome summarizes repo changes", () => {
  assert.equal(describeTickOutcome(undefined), "no outcome recorded");
  assert.match(
    describeTickOutcome({
      headBefore: "abc",
      headAfter: "def",
      committed: true,
      commits: 1,
      filesChanged: 2,
      insertions: 10,
      deletions: 1,
      dirtyFiles: 0,
      producedWork: true,
      tests: { ran: true, passed: true, total: 200, durationMs: 1000, command: "npm test" },
    }),
    /1 commit/,
  );
});
