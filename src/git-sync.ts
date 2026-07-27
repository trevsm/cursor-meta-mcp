import { execFileSync } from "node:child_process";

export interface GitSyncStatus {
  available: boolean;
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  unpushed: boolean;
  uncommittedSummary: string;
  error?: string;
}

/** Paths excluded from dirty detection (temp artifacts and local secrets). */
export function isIgnorableWorkingTreePath(path: string): boolean {
  const normalized = path.replace(/^"|"$/g, "").trim();
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => part === ".tmp" || part.startsWith(".tmp-"))) return true;
  if (parts.some((part) => part === ".env" || part.startsWith(".env.") || part === "credentials.json")) {
    return true;
  }
  return false;
}

/** Extract path(s) from one `git status --porcelain` line (handles renames). */
export function pathsFromPorcelainLine(line: string): string[] {
  const raw = line.length >= 3 ? line.slice(3).trim() : line.trim();
  if (!raw) return [];
  if (raw.includes(" -> ")) {
    return raw
      .split(" -> ")
      .map((p) => p.replace(/^"|"$/g, "").trim())
      .filter(Boolean);
  }
  return [raw.replace(/^"|"$/g, "").trim()].filter(Boolean);
}

function runGit(cwd: string, args: string[], opts?: { ignoreStderr?: boolean }): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 50_000,
    stdio: opts?.ignoreStderr ? ["ignore", "pipe", "ignore"] : undefined,
  }).trim();
}

export function gitFetch(cwd: string): { ok: boolean; error?: string } {
  try {
    runGit(cwd, ["fetch", "--all", "--prune"]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getGitSyncStatus(cwd: string): GitSyncStatus {
  try {
    const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    let ahead = 0;
    let behind = 0;

    try {
      const counts = runGit(cwd, ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`], {
        ignoreStderr: true,
      });
      const [behindStr, aheadStr] = counts.split(/\s+/);
      behind = Number(behindStr) || 0;
      ahead = Number(aheadStr) || 0;
    } catch {
      /* no upstream configured */
    }

    const porcelain = runGit(cwd, ["status", "--porcelain"]);
    const paths = porcelain
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => pathsFromPorcelainLine(line))
      .filter((path) => path.length > 0 && !isIgnorableWorkingTreePath(path));
    const dirty = paths.length > 0;
    const uncommittedSummary = dirty
      ? [...new Set(paths)].slice(0, 8).join(", ")
      : "(clean working tree)";

    return {
      available: true,
      branch,
      ahead,
      behind,
      dirty,
      unpushed: ahead > 0,
      uncommittedSummary,
    };
  } catch (error) {
    return {
      available: false,
      branch: "",
      ahead: 0,
      behind: 0,
      dirty: false,
      unpushed: false,
      uncommittedSummary: "(git unavailable)",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatGitSyncStatusForPrompt(status: GitSyncStatus): string {
  if (!status.available) {
    return status.error ? `Git unavailable: ${status.error}` : "Git unavailable.";
  }

  const parts = [`branch=${status.branch}`];
  if (status.behind > 0) parts.push(`${status.behind} commit(s) behind origin`);
  if (status.ahead > 0) parts.push(`${status.ahead} commit(s) ahead of origin`);
  if (status.dirty) parts.push(`uncommitted: ${status.uncommittedSummary}`);

  if (parts.length === 1) {
    return `Git state: ${parts[0]} — clean and synced with origin.`;
  }

  const actions: string[] = [];
  if (status.behind > 0) actions.push("pull/rebase before new work");
  if (status.dirty) actions.push("commit verified changes");
  if (status.unpushed) actions.push("push to origin");
  if (actions.length === 0 && status.ahead === 0) actions.push("synced");

  return `Git state: ${parts.join("; ")}. Action: ${actions.join(", ")}.`;
}

export const SELF_IMPROVE_GIT_RULES = [
  "Each tick: one high-value improvement → npm test → git commit → git push to keep origin current.",
  "Never stage secrets (.env, credentials). Skip temp files (.tmp-*).",
  "If git is ahead of origin or has uncommitted work, sync before starting new features.",
].join(" ");
