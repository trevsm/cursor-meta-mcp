import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  parseNodeTestSummary,
  parseShortstat,
  describeTickOutcome,
  captureRepoSnapshot,
  summarizeTickOutcome,
} = await import("../src/tick-outcome.js");

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tick-outcome-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

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
      pushed: true,
      commits: 1,
      filesChanged: 2,
      insertions: 10,
      deletions: 1,
      dirtyFiles: 0,
      producedWork: true,
      tests: { ran: true, passed: true, total: 200, durationMs: 1000, command: "npm test" },
    }),
    /1 commit.*pushed/,
  );
});

test("summarizeTickOutcome detects content change on untracked dirty file", () => {
  const dir = initRepo();
  writeFileSync(join(dir, "scratch.txt"), "alpha\n");
  const before = captureRepoSnapshot(dir);
  assert.equal(before.dirtyFiles, 1);
  writeFileSync(join(dir, "scratch.txt"), "beta\n");
  const outcome = summarizeTickOutcome({ cwd: dir, before });
  assert.equal(outcome.filesChanged, 0);
  assert.equal(outcome.dirtyFiles, 1);
  assert.equal(outcome.producedWork, true);
});

test("summarizeTickOutcome detects further edits to already-dirty tracked files", () => {
  const dir = initRepo();
  writeFileSync(join(dir, "a.txt"), "two\n");
  const before = captureRepoSnapshot(dir);
  assert.equal(before.dirtyFiles, 1);
  writeFileSync(join(dir, "a.txt"), "three\n");
  const outcome = summarizeTickOutcome({ cwd: dir, before });
  assert.equal(outcome.dirtyFiles, 1);
  assert.equal(outcome.producedWork, true);
});

test("summarizeTickOutcome reports no work when nothing changed", () => {
  const dir = initRepo();
  const before = captureRepoSnapshot(dir);
  const outcome = summarizeTickOutcome({ cwd: dir, before });
  assert.equal(outcome.producedWork, false);
  assert.equal(outcome.pushed, false);
  assert.equal(outcome.filesChanged, 0);
  assert.equal(before.dirtyFingerprint, captureRepoSnapshot(dir).dirtyFingerprint);
});

test("summarizeTickOutcome detects push that clears ahead-of-origin", () => {
  const dir = initRepo();
  const bare = mkdtempSync(join(tmpdir(), "tick-origin-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "b.txt"), "two\n");
  execFileSync("git", ["add", "b.txt"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "ahead"], { cwd: dir, stdio: "ignore" });
  const before = captureRepoSnapshot(dir);
  assert.equal(before.aheadOfUpstream, 1);
  execFileSync("git", ["push"], { cwd: dir, stdio: "ignore" });
  const outcome = summarizeTickOutcome({ cwd: dir, before });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.pushed, true);
});

test("summarizeTickOutcome detects commit and push in one tick from synced", () => {
  const dir = initRepo();
  const bare = mkdtempSync(join(tmpdir(), "tick-origin-sync-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: dir, stdio: "ignore" });
  const before = captureRepoSnapshot(dir);
  assert.equal(before.aheadOfUpstream, 0);
  writeFileSync(join(dir, "c.txt"), "three\n");
  execFileSync("git", ["add", "c.txt"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "ship"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["push"], { cwd: dir, stdio: "ignore" });
  const outcome = summarizeTickOutcome({ cwd: dir, before });
  assert.equal(outcome.committed, true);
  assert.equal(outcome.pushed, true);
  assert.equal(outcome.producedWork, true);
});
