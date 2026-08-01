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

  // Deleting the directory does not unregister the worktree, so git still holds
  // a record pointing at the path we just removed and the next `worktree add`
  // dies with "missing but already registered". Prune before adding — without
  // this, worker N fails on every run after its first.
  safeGit(repoRoot, ["worktree", "prune"], { ignoreStderr: true });

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

/** Branch currently checked out at the repo root, or undefined when detached. */
export function currentBranchName(repoRoot: string): string | undefined {
  const branch = safeGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { ignoreStderr: true });
  return branch && branch !== "HEAD" ? branch : undefined;
}

export interface WorktreeSyncResult {
  synced: boolean;
  /** Set when the worktree could not be advanced (dirty tree or conflict). */
  reason?: string;
}

/**
 * Bring a worker's worktree up to the base branch before it starts new work.
 *
 * Worktrees fork once at launch and never move, so a worker picking up its
 * second mission is building against whatever HEAD was hours ago — it cannot
 * see work its peers already merged. That is what produced a rewritten
 * `app.ts` and a second copy of a feature that already existed.
 *
 * Only runs on a clean tree: mid-slice edits are the worker's, not ours to
 * rebase.
 */
export function syncWorktreeWithBase(
  worktreePath: string,
  baseBranch: string,
): WorktreeSyncResult {
  const dirty = safeGit(worktreePath, ["status", "--porcelain"], { ignoreStderr: true });
  if (dirty === undefined) return { synced: false, reason: "worktree unavailable" };
  if (dirty.trim().length > 0) {
    return { synced: false, reason: "uncommitted changes — left alone mid-slice" };
  }

  const merged = safeGit(worktreePath, ["merge", "--ff-only", baseBranch], {
    ignoreStderr: true,
  });
  if (merged !== undefined) return { synced: true };

  const noFf = safeGit(worktreePath, ["merge", "--no-edit", baseBranch], { ignoreStderr: true });
  if (noFf !== undefined) return { synced: true };

  safeGit(worktreePath, ["merge", "--abort"], { ignoreStderr: true });
  return { synced: false, reason: `conflicts merging ${baseBranch}` };
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
