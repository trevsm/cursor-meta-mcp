import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  auditGroundTruth,
  detectCompletionClaims,
  formatTickReportFooter,
  parseTickReport,
  TICK_REPORT_LABEL,
} = await import("../src/ground-truth.js");
const { appendLearning, compactLearnings, formatLearningsForPrompt, recordTickLesson } = await import("../src/learnings.js");

test("parseTickReport reads JSON footer", () => {
  const tail = [
    "Shipped dashboard fix.",
    TICK_REPORT_LABEL,
    '{"done":false,"testsPass":true,"committed":true,"pushed":false}',
  ].join("\n");
  assert.deepEqual(parseTickReport(tail), {
    done: false,
    testsPass: true,
    committed: true,
    pushed: false,
  });
});

test("detectCompletionClaims ignores prose without tick report", () => {
  const claims = detectCompletionClaims("All tests pass. Committed and pushed.");
  assert.deepEqual(claims, {
    claimedDone: false,
    claimedTestsPass: false,
    claimedCommitted: false,
    claimedPushed: false,
  });
});

test("detectCompletionClaims maps structured report booleans", () => {
  const tail = formatTickReportFooter({
    done: true,
    testsPass: true,
    committed: true,
    pushed: true,
  });
  const claims = detectCompletionClaims(tail);
  assert.equal(claims.claimedDone, true);
  assert.equal(claims.claimedTestsPass, true);
  assert.equal(claims.claimedCommitted, true);
  assert.equal(claims.claimedPushed, true);
});

test("parseTickReport reads fenced JSON footer", () => {
  const tail = [
    "Shipped fix.",
    TICK_REPORT_LABEL,
    "```json",
    '{"done":false,"testsPass":true,"committed":true,"pushed":false}',
    "```",
  ].join("\n");
  assert.deepEqual(parseTickReport(tail), {
    done: false,
    testsPass: true,
    committed: true,
    pushed: false,
  });
});

test("auditGroundTruth blocks missing tick report when work was produced", () => {
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
    tests: { ran: true, passed: true, total: 10, durationMs: 50, command: "npm run test:fast" },
  });
  assert.equal(audit.blocked, true);
  assert.equal(audit.missingTickReport, true);
  assert.ok(audit.violations.some((v) => /missing structured tick report/i.test(v)));
  // Missing footer on measured verified work is a compliance nag, not fabrication.
  assert.equal(audit.fabrication, false);
});

test("auditGroundTruth blocks false tests-pass in structured report", () => {
  const tail = formatTickReportFooter({ testsPass: true, committed: false, pushed: false, done: false });
  const audit = auditGroundTruth(tail, {
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
  assert.ok(audit.violations.some((v) => /verification|test:fast/i.test(v)));
  // Claimed testsPass against a failing measured run is fabrication.
  assert.equal(audit.fabrication, true);
});

test("auditGroundTruth passes when structured report matches outcome", () => {
  const tail = formatTickReportFooter({ testsPass: true, committed: true, pushed: false, done: false });
  const audit = auditGroundTruth(tail, {
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

test("auditGroundTruth blocks false push in structured report", () => {
  const tail = formatTickReportFooter({ testsPass: true, committed: true, pushed: true, done: false });
  const audit = auditGroundTruth(tail, {
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
  assert.equal(audit.fabrication, true);
});

test("auditGroundTruth marks clean matching reports as non-fabricated", () => {
  const tail = formatTickReportFooter({ testsPass: true, committed: true, pushed: false, done: false });
  const audit = auditGroundTruth(tail, {
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
  assert.equal(audit.fabrication, false);
  assert.equal(audit.blocked, false);
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

test("auditGroundTruth does not call an unverifiable push claim fabrication", () => {
  const tail = formatTickReportFooter({ testsPass: true, committed: true, pushed: true, done: false });
  const audit = auditGroundTruth(tail, {
    committed: true,
    pushed: false,
    pushMeasurable: false,
    commits: 1,
    filesChanged: 2,
    insertions: 30,
    deletions: 1,
    dirtyFiles: 0,
    producedWork: true,
    tests: { ran: true, passed: true, durationMs: 10, command: "npm run test:fast" },
  });

  assert.equal(audit.fabrication, false, "worktree branches cannot verify push — do not brand the worker a liar");
  assert.equal(audit.blocked, false);
  assert.deepEqual(audit.violations, []);
});

test("auditGroundTruth still flags a false push claim when upstream is trackable", () => {
  const tail = formatTickReportFooter({ testsPass: true, committed: true, pushed: true, done: false });
  const audit = auditGroundTruth(tail, {
    committed: true,
    pushed: false,
    pushMeasurable: true,
    commits: 1,
    filesChanged: 2,
    insertions: 30,
    deletions: 1,
    dirtyFiles: 0,
    producedWork: true,
    tests: { ran: true, passed: true, durationMs: 10, command: "npm run test:fast" },
  });

  assert.equal(audit.fabrication, true);
  assert.match(audit.violations.join("\n"), /origin was not updated/);
});

test("auditGroundTruth does not fabricate on a clean tick where verification never ran", () => {
  // Verify is skipped when a tick produces no work, so there is no measurement
  // to contradict. This is the shape that burned 5 of 6 ticks for a worker
  // whose mission was already complete.
  const tail = formatTickReportFooter({ testsPass: true, committed: false, pushed: false, done: true });
  const audit = auditGroundTruth(
    tail,
    {
      committed: false,
      pushed: false,
      pushMeasurable: false,
      commits: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      dirtyFiles: 0,
      producedWork: false,
      tests: undefined,
    },
    { priorWorkInSession: true },
  );

  assert.equal(audit.fabrication, false, "an honest report on finished work is not a lie");
  assert.equal(audit.blocked, false);
});

test("auditGroundTruth still fabricates when verification ran and failed", () => {
  const tail = formatTickReportFooter({ testsPass: true, committed: true, pushed: false, done: false });
  const audit = auditGroundTruth(tail, {
    committed: true,
    pushed: false,
    pushMeasurable: true,
    commits: 1,
    filesChanged: 1,
    insertions: 5,
    deletions: 0,
    dirtyFiles: 0,
    producedWork: true,
    tests: { ran: true, passed: false, failed: 2, durationMs: 10, command: "pnpm run test" },
  });

  assert.equal(audit.fabrication, true);
  assert.match(audit.violations.join("\n"), /did not pass/);
});

test("auditGroundTruth fabricates a done claim when the session produced nothing at all", () => {
  const tail = formatTickReportFooter({ testsPass: false, committed: false, pushed: false, done: true });
  const audit = auditGroundTruth(
    tail,
    {
      committed: false,
      pushed: false,
      pushMeasurable: true,
      commits: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      dirtyFiles: 0,
      producedWork: false,
    },
    { priorWorkInSession: false },
  );

  assert.equal(audit.fabrication, true);
  assert.match(audit.violations.join("\n"), /no repo change detected in this session/);
});
