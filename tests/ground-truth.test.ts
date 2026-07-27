import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { auditGroundTruth, detectCompletionClaims } = await import("../src/ground-truth.js");
const { appendLearning, compactLearnings, formatLearningsForPrompt, recordTickLesson } = await import("../src/learnings.js");

test("detectCompletionClaims finds tests-pass and commit language", () => {
  const claims = detectCompletionClaims("All tests pass. Committed and pushed.");
  assert.equal(claims.claimedTestsPass, true);
  assert.equal(claims.claimedCommitted, true);
  assert.equal(claims.claimedPushed, true);
});

test("detectCompletionClaims ignores negated commit language", () => {
  const claims = detectCompletionClaims("Not committed yet; npm run test:fast passed.");
  assert.equal(claims.claimedCommitted, false);
  assert.equal(claims.claimedPushed, false);
  assert.equal(claims.claimedTestsPass, true);
});

test("detectCompletionClaims ignores negated push language", () => {
  assert.equal(detectCompletionClaims("I haven't pushed yet.").claimedPushed, false);
  assert.equal(detectCompletionClaims("Not pushed to origin.").claimedPushed, false);
  assert.equal(detectCompletionClaims("I didn't push.").claimedPushed, false);
  assert.equal(detectCompletionClaims("Committed and pushed to origin.").claimedPushed, true);
});

test("detectCompletionClaims ignores negated tests-pass language", () => {
  assert.equal(detectCompletionClaims("Tests didn't pass.").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("npm test did not pass.").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("tests do not pass yet.").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("All tests pass.").claimedTestsPass, true);
  assert.equal(detectCompletionClaims("npm run test:fast passed.").claimedTestsPass, true);
});

test("detectCompletionClaims ignores conditional tests-pass phrasing", () => {
  assert.equal(detectCompletionClaims("once tests are passing we ship").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("when all tests pass we merge").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("if tests pass then commit").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("Will commit after tests pass.").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("Wait until tests pass before claiming success.").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("before tests pass we should not commit").claimedTestsPass, false);
  assert.equal(detectCompletionClaims("tests are passing now").claimedTestsPass, true);
});

test("detectCompletionClaims ignores procedural git language in prompts", () => {
  const constitution =
    "Ground-truth: never claim tests pass without npm run test:fast + git commit this tick.";
  const claims = detectCompletionClaims(constitution);
  assert.equal(claims.claimedTestsPass, false);
  assert.equal(claims.claimedCommitted, false);
  assert.equal(claims.claimedPushed, false);
  assert.equal(detectCompletionClaims("Each tick: git commit → git push.").claimedCommitted, false);
  assert.equal(detectCompletionClaims("Each tick: git commit → git push.").claimedPushed, false);
});

test("detectCompletionClaims ignores speculative should-work-now phrasing", () => {
  const claims = detectCompletionClaims("This should work now that tests pass.");
  assert.equal(claims.claimedDone, false);
  assert.equal(claims.claimedTestsPass, false);
  assert.equal(detectCompletionClaims("Should work now.").claimedDone, true);
});

test("detectCompletionClaims ignores haven't/didn't commit and imperative complete", () => {
  assert.equal(detectCompletionClaims("I haven't committed these changes.").claimedCommitted, false);
  assert.equal(detectCompletionClaims("I didn't commit yet.").claimedCommitted, false);
  assert.equal(detectCompletionClaims("Next: complete the helper and add tests.").claimedDone, false);
  assert.equal(detectCompletionClaims("All done. Task is complete.").claimedDone, true);
});

test("detectCompletionClaims ignores in-progress finished phrasing", () => {
  assert.equal(detectCompletionClaims("Finished refactoring the helper.").claimedDone, false);
  assert.equal(detectCompletionClaims("finished").claimedDone, true);
});

test("auditGroundTruth blocks should-work-now claims without recorded outcome", () => {
  const audit = auditGroundTruth("Should work now.", undefined);
  assert.equal(audit.blocked, true);
  assert.equal(audit.claimedDone, true);
});

test("auditGroundTruth blocks ready-to-merge claims without recorded outcome", () => {
  const audit = auditGroundTruth("Ready to merge after review.", undefined);
  assert.equal(audit.blocked, true);
  assert.equal(audit.claimedDone, true);
  assert.ok(audit.violations.some((v) => /no tick outcome recorded/i.test(v)));
});

test("auditGroundTruth blocks done claims without recorded outcome", () => {
  const audit = auditGroundTruth("All done. Task is complete.", undefined);
  assert.equal(audit.blocked, true);
  assert.ok(audit.violations.some((v) => /no tick outcome recorded/i.test(v)));
});

test("auditGroundTruth blocks done claims with no repo change", () => {
  const audit = auditGroundTruth("All done.", {
    headBefore: "a",
    headAfter: "a",
    committed: false,
    pushed: false,
    commits: 0,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    dirtyFiles: 0,
    producedWork: false,
  });
  assert.equal(audit.blocked, true);
  assert.ok(audit.violations.some((v) => /no repo change detected/i.test(v)));
});

test("auditGroundTruth blocks false tests-pass claims", () => {
  const audit = auditGroundTruth("All tests pass now.", {
    headBefore: "a",
    headAfter: "a",
    committed: false,
    pushed: false,
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
    pushed: false,
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

test("auditGroundTruth blocks false push claims", () => {
  const audit = auditGroundTruth("Committed and pushed to origin.", {
    headBefore: "a",
    headAfter: "b",
    committed: true,
    pushed: false,
    commits: 1,
    filesChanged: 1,
    insertions: 2,
    deletions: 0,
    dirtyFiles: 0,
    producedWork: true,
    tests: { ran: true, passed: true, total: 10, durationMs: 50, command: "npm run test:fast" },
  });
  assert.equal(audit.blocked, true);
  assert.ok(audit.violations.some((v) => /claimed push/i.test(v)));
  assert.equal(audit.claimedPushed, true);
  assert.equal(audit.claimedCommitted, true);
});

test("learnings append and inject into prompt", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-"));
  appendLearning("Always run test:fast before claiming done", metaDir);
  const prompt = formatLearningsForPrompt(metaDir);
  assert.match(prompt, /Prior lessons/);
  assert.match(prompt, /test:fast/);
  assert.match(readFileSync(join(metaDir, "world", "learnings.md"), "utf8"), /test:fast/);
});

test("appendLearning flattens multi-line lessons to one row", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-flat-"));
  assert.equal(
    appendLearning("Tick infra failure: line1\nline2\nline3", metaDir),
    true,
  );
  const body = readFileSync(join(metaDir, "world", "learnings.md"), "utf8");
  assert.equal(body.split("\n").filter(Boolean).length, 1);
  assert.match(body, /line1 line2 line3/);
});

test("recordTickLesson writes from test failure outcome", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-test-fail-"));
  const lesson = recordTickLesson({
    metaDir,
    outcome: {
      headBefore: "a",
      headAfter: "b",
      committed: true,
      pushed: false,
      commits: 1,
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
      dirtyFiles: 0,
      producedWork: true,
      tests: { ran: true, passed: false, failed: 2, durationMs: 100, command: "npm run test:fast" },
    },
  });
  assert.ok(lesson);
  assert.match(lesson, /test:fast failed \(2 failing\)/);
  assert.match(formatLearningsForPrompt(metaDir), /fix before claiming done/i);
});

test("recordTickLesson writes from ground-truth audit", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-gt-"));
  const lesson = recordTickLesson({
    metaDir,
    audit: {
      claimedDone: true,
      claimedTestsPass: true,
      claimedCommitted: false,
      claimedPushed: false,
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

test("recordTickLesson maps missing Agent CLI ENOENT", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-enoent-"));
  const lesson = recordTickLesson({
    metaDir,
    error: "spawn /Users/trevorsmith/.local/bin/agent ENOENT",
  });
  assert.ok(lesson);
  assert.match(lesson, /ENOENT means the binary is missing/i);
  assert.match(formatLearningsForPrompt(metaDir), /Install Cursor Agent CLI/i);
});

test("compactLearnings drops raw infra dumps superseded by classified lessons", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "learnings-compact-"));
  appendLearning(
    "Tick infra failure: /bin/sh: ship: command not found\nsyntax error near unexpected token",
    metaDir,
  );
  appendLearning(
    "Tick infra failure: Connection lost, reconnecting to https://agentn.global.api5.cursor.sh",
    metaDir,
  );
  appendLearning(
    "Tick infra failure: spawn /Users/trevorsmith/.local/bin/agent ENOENT",
    metaDir,
  );
  appendLearning(
    "Never spawn Agent CLI with shell:true — prompts with ;/`()` are executed by sh; pass argv without a shell",
    metaDir,
  );
  appendLearning(
    "Agent transport dropped mid-tick — retry once; if persistent, check network or fall back to IDE worker",
    metaDir,
  );
  appendLearning(
    "Install Cursor Agent CLI at ~/.local/bin/agent before CLI fleet workers — ENOENT means the binary is missing",
    metaDir,
  );
  // Orphans left by a prior broken compact of multi-line dumps
  writeFileSync(
    join(metaDir, "world", "learnings.md"),
    `${readFileSync(join(metaDir, "world", "learnings.md"), "utf8")}- [2026-07-27] Retry attempt 1...\n- [2026-07-27] /bin/sh: -c: line 2: syntax error near unexpected token \`('\nundated orphan fragment\n`,
  );
  const removed = compactLearnings(metaDir);
  assert.ok(removed >= 2);
  const body = readFileSync(join(metaDir, "world", "learnings.md"), "utf8");
  assert.equal(/Tick infra failure:/i.test(body), false);
  assert.equal(/Retry attempt/i.test(body), false);
  assert.equal(/undated orphan/i.test(body), false);
  assert.match(body, /shell:true/i);
  assert.match(body, /transport dropped/i);
  assert.match(body, /ENOENT means the binary is missing/i);
});
