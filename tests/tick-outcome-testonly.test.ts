import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  captureRepoSnapshot,
  isTestOnlyChange,
  isTestOnlyPath,
  listTickChangedPaths,
  summarizeTickOutcome,
  TEST_ONLY_FEATURE_RATIO,
} from "../src/tick-outcome.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tick-testonly-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "tests", "a.test.ts"), "test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("isTestOnlyPath recognizes tests/ and *.test.ts", () => {
  assert.equal(isTestOnlyPath("tests/foo.test.ts"), true);
  assert.equal(isTestOnlyPath("src/foo.test.ts"), true);
  assert.equal(isTestOnlyPath("src/foo.ts"), false);
});

test("summarizeTickOutcome marks test-only changes", () => {
  const dir = initRepo();
  const snapshot = captureRepoSnapshot(dir);
  writeFileSync(join(dir, "tests", "b.test.ts"), "new test\n");
  const outcome = summarizeTickOutcome({ cwd: dir, before: snapshot });
  assert.equal(outcome.testOnly, true);
  assert.deepEqual(outcome.changedPaths, ["tests/b.test.ts"]);
});

test("summarizeTickOutcome marks mixed src+tests as not test-only", () => {
  const dir = initRepo();
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, "tests", "a.test.ts"), "updated\n");
  const before = captureRepoSnapshot(dir);
  const outcome = summarizeTickOutcome({ cwd: dir, before });
  assert.equal(outcome.testOnly, false);
});

test("listTickChangedPaths returns committed diff paths", () => {
  const dir = initRepo();
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 9;\n");
  execFileSync("git", ["add", "src/a.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "change"], { cwd: dir, stdio: "ignore" });
  const headBefore = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: dir, encoding: "utf8" }).trim();
  const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const paths = listTickChangedPaths(dir, { headBefore, headAfter, committed: true });
  assert.deepEqual(paths, ["src/a.ts"]);
});

test("TEST_ONLY_FEATURE_RATIO is 3", () => {
  assert.equal(TEST_ONLY_FEATURE_RATIO, 3);
  assert.equal(isTestOnlyChange(["tests/a.test.ts"]), true);
  assert.equal(isTestOnlyChange([]), false);
});
