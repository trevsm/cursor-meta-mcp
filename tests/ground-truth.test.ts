import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { auditGroundTruth, detectCompletionClaims } = await import("../src/ground-truth.js");
const { appendLearning, formatLearningsForPrompt, recordTickLesson } = await import("../src/learnings.js");

test("detectCompletionClaims finds tests-pass and commit language", () => {
  const claims = detectCompletionClaims("All tests pass. Committed and pushed.");
  assert.equal(claims.claimedTestsPass, true);
  assert.equal(claims.claimedCommitted, true);
});

test("detectCompletionClaims ignores negated commit language", () => {
  const claims = detectCompletionClaims("Not committed yet; npm run test:fast passed.");
  assert.equal(claims.claimedCommitted, false);
  assert.equal(claims.claimedTestsPass, true);
});

test("detectCompletionClaims ignores haven't/didn't commit and imperative complete", () => {
  assert.equal(detectCompletionClaims("I haven't committed these changes.").claimedCommitted, false);
  assert.equal(detectCompletionClaims("I didn't commit yet.").claimedCommitted, false);
  assert.equal(detectCompletionClaims("Next: complete the helper and add tests.").claimedDone, false);
  assert.equal(detectCompletionClaims("All done. Task is complete.").claimedDone, true);
});

test("auditGroundTruth blocks false tests-pass claims", () => {
  const audit = auditGroundTruth("All tests pass now.", {
    headBefore: "a",
    headAfter: "a",
    committed: false,
    commits: 0,
    filesChanged: 2,
    insertions: 5,
    deletions: 0,
    dirtyFiles: 1,
    producedWork: true,
    tests: { ran: true, passed: false, failed: 3, durationMs: 100, command: "npm run test:fast" },
  });
  assert.equal(audit.blocked, true);
  assert.ok(audit.violations.some((v) => v.includes("test:fast")));
  assert.ok(audit.correctionPrompt?.includes("Ground-truth"));
});

test("auditGroundTruth passes when claims match outcome", () => {
  const audit = auditGroundTruth("All tests pass.", {
    headBefore: "a",
    headAfter: "b",
    committed: true,
    commits: 1,
    filesChanged: 1,
    insertions: 2,
    deletions: 0,
    dirtyFiles: 0,
    producedWork: true,
    tests: { ran: true, passed: true, total: 200, durationMs: 100, command: "npm run test:fast" },
  });
  assert.equal(audit.blocked, false);
  assert.equal(audit.violations.length, 0);
});

test("learnings append and inject into prompt", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-"));
  appendLearning("Always run test:fast before claiming done", metaDir);
  const prompt = formatLearningsForPrompt(metaDir);
  assert.match(prompt, /Prior lessons/);
  assert.match(prompt, /test:fast/);
  assert.match(readFileSync(join(metaDir, "world", "learnings.md"), "utf8"), /test:fast/);
});

test("recordTickLesson writes from ground-truth audit", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-gt-"));
  const lesson = recordTickLesson({
    metaDir,
    audit: {
      claimedDone: true,
      claimedTestsPass: true,
      claimedCommitted: false,
      violations: ["claimed tests pass but test:fast did not pass this tick"],
      blocked: true,
    },
  });
  assert.ok(lesson);
  assert.match(formatLearningsForPrompt(metaDir), /ground truth/i);
});

test("recordTickLesson writes from tick infra errors", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-err-"));
  const lesson = recordTickLesson({
    metaDir,
    error: "No auth available. Set CURSOR_API_KEY or run ~/.local/bin/agent login.",
  });
  assert.ok(lesson);
  assert.match(formatLearningsForPrompt(metaDir), /Preflight SDK auth/i);
  const dup = recordTickLesson({ metaDir, error: "No auth available. Set CURSOR_API_KEY or run ~/.local/bin/agent login." });
  assert.equal(dup, null);
  assert.equal(readFileSync(join(metaDir, "world", "learnings.md"), "utf8").split("\n").filter(Boolean).length, 1);
});

test("recordTickLesson maps shell-metacharacter CLI failures", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-shell-"));
  const lesson = recordTickLesson({
    metaDir,
    error:
      "/bin/sh: ship: command not found\n/bin/sh: -c: line 2: syntax error near unexpected token `('",
  });
  assert.ok(lesson);
  assert.match(lesson, /shell:true/i);
  assert.match(formatLearningsForPrompt(metaDir), /argv without a shell/i);
});

test("recordTickLesson maps agent transport drops", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-conn-"));
  const lesson = recordTickLesson({
    metaDir,
    error:
      "Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1)...",
  });
  assert.ok(lesson);
  assert.match(lesson, /transport dropped/i);
});
