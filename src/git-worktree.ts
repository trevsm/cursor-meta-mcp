import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { metaPath } from "./meta-home.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head?: string;
}

export interface MergeResult {
  ok: boolean;
  merged: boolean;
  branch: string;
  error?: string;
}

function git(cwd: string, args: string[], opts?: { ignoreStderr?: boolean }): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2_000_000,
    stdio: opts?.ignoreStderr ? ["ignore", "pipe", "ignore"] : undefined,
  }).trim();
}

function safeGit(cwd: string, args: string[], opts?: { ignoreStderr?: boolean }): string | undefined {
  try {
    return git(cwd, args, opts);
  } catch {
    return undefined;
  }
}

/** Base directory for fleet worker worktrees. */
export function defaultWorktreesRoot(): string {
  return metaPath("worktrees");
}

/** Sanitize a worker name into a branch-safe slug. */
export function workerBranchName(workerName: string, index: number): string {
  const slug = workerName.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `fleet/${slug || "worker"}-${index}`;
}

/**
 * Create an isolated worktree for a fleet worker.
 *
 * Each worker gets its own branch under `fleet/*` so parallel agents can commit
 * without stomping the shared main checkout.
 */
export function createWorkerWorktree(
  repoRoot: string,
  workerName: string,
  index: number,
  worktreesRoot = defaultWorktreesRoot(),
): WorktreeInfo {
  mkdirSync(worktreesRoot, { recursive: true });
  const branch = workerBranchName(workerName, index);
  const path = join(worktreesRoot, `${workerName.replace(/[^a-zA-Z0-9]+/g, "-")}-${index}`);

  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }

  // Branch may already exist from a prior run; reuse it.
  const branchExists = safeGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    ignoreStderr: true,
  }) !== undefined;

  if (branchExists) {
    git(repoRoot, ["worktree", "add", path, branch]);
  } else {
    git(repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  }

  const head = safeGit(path, ["rev-parse", "HEAD"]);
  return { path, branch, head };
}

export function removeWorkerWorktree(repoRoot: string, info: WorktreeInfo): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", info.path]);
  } catch {
    if (existsSync(info.path)) {
      rmSync(info.path, { recursive: true, force: true });
      safeGit(repoRoot, ["worktree", "prune"]);
    }
  }
}

/**
 * Merge a worker branch back into the target branch (default: current HEAD branch).
 *
 * Fast-forward when possible; otherwise records failure for manual resolution.
 */
export function mergeWorkerBranch(
  repoRoot: string,
  worker: WorktreeInfo,
  targetBranch?: string,
): MergeResult {
  const target = targetBranch ?? safeGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main";
  try {
    git(repoRoot, ["fetch", "--all", "--prune"], { ignoreStderr: true });
    git(repoRoot, ["checkout", target]);
    const ff = safeGit(repoRoot, ["merge", "--ff-only", worker.branch]);
    if (ff !== undefined) {
      return { ok: true, merged: true, branch: worker.branch };
    }
    git(repoRoot, ["merge", "--no-edit", worker.branch]);
    return { ok: true, merged: true, branch: worker.branch };
  } catch (error) {
    safeGit(repoRoot, ["merge", "--abort"]);
    return {
      ok: false,
      merged: false,
      branch: worker.branch,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  const raw = safeGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!raw) return [];

  const rows: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path && current.branch) rows.push(current as WorktreeInfo);
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    }
  }
  if (current.path && current.branch) rows.push(current as WorktreeInfo);
  return rows;
}
