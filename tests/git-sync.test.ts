import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  formatGitSyncStatusForPrompt,
  getGitSyncStatus,
  gitFetch,
  isIgnorableWorkingTreePath,
  pathsFromPorcelainLine,
  SELF_IMPROVE_GIT_RULES,
} from "../src/git-sync.js";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-sync-"));
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "initial"]);
  return dir;
}

test("getGitSyncStatus reports clean synced repo", () => {
  const dir = initRepo();
  const status = getGitSyncStatus(dir);
  assert.equal(status.available, true);
  assert.equal(status.branch, "main");
  assert.equal(status.dirty, false);
  assert.equal(status.ahead, 0);
});

test("getGitSyncStatus reports dirty working tree", () => {
  const dir = initRepo();
  writeFileSync(join(dir, "dirty.txt"), "change\n");
  const status = getGitSyncStatus(dir);
  assert.equal(status.dirty, true);
  assert.match(status.uncommittedSummary, /dirty\.txt/);
});

test("formatGitSyncStatusForPrompt urges pull when behind origin", () => {
  const prompt = formatGitSyncStatusForPrompt({
    available: true,
    branch: "main",
    ahead: 0,
    behind: 2,
    dirty: false,
    unpushed: false,
    uncommittedSummary: "(clean working tree)",
  });
  assert.match(prompt, /2 commit\(s\) behind origin/);
  assert.match(prompt, /pull\/rebase before new work/);
});

test("formatGitSyncStatusForPrompt reports clean synced repo", () => {
  const prompt = formatGitSyncStatusForPrompt({
    available: true,
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: false,
    unpushed: false,
    uncommittedSummary: "(clean working tree)",
  });
  assert.match(prompt, /clean and synced with origin/);
});

test("formatGitSyncStatusForPrompt urges commit and push when dirty/ahead", () => {
  const prompt = formatGitSyncStatusForPrompt({
    available: true,
    branch: "main",
    ahead: 2,
    behind: 0,
    dirty: true,
    unpushed: true,
    uncommittedSummary: "src/foo.ts",
  });
  assert.match(prompt, /2 commit\(s\) ahead/);
  assert.match(prompt, /commit verified changes/);
  assert.match(prompt, /push to origin/);
});

test("getGitSyncStatus ignores .tmp-* paths when summarizing dirty tree", () => {
  const dir = initRepo();
  writeFileSync(join(dir, ".tmp-test-results.txt"), "noise\n");
  writeFileSync(join(dir, "src-fix.ts"), "real\n");
  const status = getGitSyncStatus(dir);
  assert.equal(status.dirty, true);
  assert.match(status.uncommittedSummary, /src-fix\.ts/);
  assert.doesNotMatch(status.uncommittedSummary, /\.tmp-test-results/);
});

test("getGitSyncStatus treats tmp-only working tree as clean for prompts", () => {
  const dir = initRepo();
  writeFileSync(join(dir, ".tmp-test-summary.txt"), "noise\n");
  const status = getGitSyncStatus(dir);
  assert.equal(status.dirty, false);
  assert.equal(status.uncommittedSummary, "(clean working tree)");
});

test("SELF_IMPROVE_GIT_RULES requires commit and push each tick", () => {
  assert.match(SELF_IMPROVE_GIT_RULES, /git commit → git push/);
  assert.match(SELF_IMPROVE_GIT_RULES, /npm test/);
  assert.match(SELF_IMPROVE_GIT_RULES, /\.tmp-\*/);
});

test("isIgnorableWorkingTreePath skips temp and secret paths", () => {
  assert.equal(isIgnorableWorkingTreePath(".tmp-test-results.txt"), true);
  assert.equal(isIgnorableWorkingTreePath("nested/.tmp-log/out.txt"), true);
  assert.equal(isIgnorableWorkingTreePath(".env"), true);
  assert.equal(isIgnorableWorkingTreePath(".env.local"), true);
  assert.equal(isIgnorableWorkingTreePath("config/credentials.json"), true);
  assert.equal(isIgnorableWorkingTreePath("src/foo.ts"), false);
  assert.equal(isIgnorableWorkingTreePath(".tmpdir"), false);
});

test("pathsFromPorcelainLine handles renames and quotes", () => {
  assert.deepEqual(pathsFromPorcelainLine(" M src/foo.ts"), ["src/foo.ts"]);
  assert.deepEqual(pathsFromPorcelainLine('R  "old name.ts" -> "new name.ts"'), [
    "old name.ts",
    "new name.ts",
  ]);
  assert.deepEqual(pathsFromPorcelainLine("R  .env -> .env.backup"), [".env", ".env.backup"]);
});

test("getGitSyncStatus treats only .tmp-* and secret paths as clean", () => {
  const dir = initRepo();
  writeFileSync(join(dir, ".tmp-test-results.txt"), "noise\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, ".env.local"), "SECRET=2\n");
  const status = getGitSyncStatus(dir);
  assert.equal(status.dirty, false);
  assert.equal(status.uncommittedSummary, "(clean working tree)");
});

test("getGitSyncStatus ignores rename of secret-only paths", () => {
  const dir = initRepo();
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  runGit(dir, ["add", ".env"]);
  runGit(dir, ["commit", "-m", "add env"]);
  runGit(dir, ["mv", ".env", ".env.local"]);
  const status = getGitSyncStatus(dir);
  assert.equal(status.dirty, false);
  assert.equal(status.uncommittedSummary, "(clean working tree)");
});

test("gitFetch succeeds in local repo", () => {
  const dir = initRepo();
  const result = gitFetch(dir);
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test("formatGitSyncStatusForPrompt reports unavailable git with error", () => {
  const prompt = formatGitSyncStatusForPrompt({
    available: false,
    branch: "",
    ahead: 0,
    behind: 0,
    dirty: false,
    unpushed: false,
    uncommittedSummary: "(git unavailable)",
    error: "not a git repository",
  });
  assert.match(prompt, /Git unavailable: not a git repository/);
});
