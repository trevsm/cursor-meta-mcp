import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createWorkerWorktree, syncWorktreeWithBase, workerBranchName } = await import(
  "../src/git-worktree.js"
);

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("workerBranchName slugifies worker names", () => {
  assert.equal(workerBranchName("sdk-worker-1", 2), "fleet/sdk-worker-1-2");
  assert.match(workerBranchName("worker dedicated!", 1), /^fleet\//);
});

test("createWorkerWorktree recovers when a prior worktree dir was deleted but stays registered", () => {
  const repo = initRepo();
  const root = mkdtempSync(join(tmpdir(), "wt-root-"));

  const first = createWorkerWorktree(repo, "sdk-worker", 1, root);
  assert.ok(existsSync(first.path));

  // Exactly what a killed or cleaned-up run leaves behind: directory gone,
  // git registration still present.
  rmSync(first.path, { recursive: true, force: true });

  const second = createWorkerWorktree(repo, "sdk-worker", 1, root);
  assert.ok(
    existsSync(second.path),
    "second launch must prune the stale registration instead of failing into the shared checkout",
  );
  assert.equal(second.branch, first.branch);
});

test("syncWorktreeWithBase pulls in work merged to the base since the worktree forked", () => {
  const repo = initRepo();
  const root = mkdtempSync(join(tmpdir(), "wt-sync-"));
  const wt = createWorkerWorktree(repo, "sdk-worker", 1, root);

  // Peer work lands on the base branch after this worktree already forked.
  writeFileSync(join(repo, "peer.txt"), "merged by another coder\n");
  execFileSync("git", ["add", "peer.txt"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "peer work"], { cwd: repo, stdio: "ignore" });
  assert.ok(!existsSync(join(wt.path, "peer.txt")), "worktree starts blind to it");

  const result = syncWorktreeWithBase(wt.path, "main");
  assert.equal(result.synced, true, result.reason);
  assert.ok(
    existsSync(join(wt.path, "peer.txt")),
    "worker must see peer work before starting its next mission",
  );
});

test("syncWorktreeWithBase leaves a dirty worktree alone mid-slice", () => {
  const repo = initRepo();
  const root = mkdtempSync(join(tmpdir(), "wt-sync-dirty-"));
  const wt = createWorkerWorktree(repo, "sdk-worker", 2, root);

  writeFileSync(join(wt.path, "in-progress.txt"), "half-written slice\n");
  const result = syncWorktreeWithBase(wt.path, "main");

  assert.equal(result.synced, false);
  assert.match(result.reason ?? "", /uncommitted/);
  assert.ok(existsSync(join(wt.path, "in-progress.txt")), "worker edits must survive");
});
