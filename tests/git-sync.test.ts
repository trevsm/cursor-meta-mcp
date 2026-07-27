import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  formatGitSyncStatusForPrompt,
  getGitSyncStatus,
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

test("formatGitSyncStatusForPrompt reports dirty/ahead without urging unsolicited commit/push", () => {
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
  assert.match(prompt, /commit only if explicitly asked/);
  assert.match(prompt, /push only if explicitly asked/);
});

test("SELF_IMPROVE_GIT_RULES forbids unsolicited commits", () => {
  assert.match(SELF_IMPROVE_GIT_RULES, /Do not create git commits unless explicitly asked/);
  assert.match(SELF_IMPROVE_GIT_RULES, /npm test/);
});
