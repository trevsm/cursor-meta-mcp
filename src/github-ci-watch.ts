import { execFileSync } from "node:child_process";

import type { GithubCiRun, GithubCiSnapshot } from "./fleet-ci-policy.js";

function safeGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return undefined;
  }
}

function ghAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { encoding: "utf8", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function parseRuns(raw: string): GithubCiRun[] {
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => ({
      id: Number(row.databaseId ?? row.id ?? 0),
      status: String(row.status ?? "unknown"),
      conclusion: row.conclusion == null ? null : String(row.conclusion),
      title: String(row.displayTitle ?? row.name ?? "workflow"),
      url: String(row.url ?? ""),
      event: String(row.event ?? ""),
      createdAt: String(row.createdAt ?? row.startedAt ?? ""),
    }));
  } catch {
    return [];
  }
}

function summarizeRuns(runs: GithubCiRun[]): string {
  if (runs.length === 0) return "No recent GitHub Actions runs for this branch.";
  const latest = runs[0]!;
  const state =
    latest.status === "completed"
      ? latest.conclusion ?? "completed"
      : latest.status;
  return `GitHub CI (watch-only): latest run ${state} — ${latest.title}`;
}

/** Read-only GitHub Actions status for dashboard/watcher. Never used to gate ticks. */
export function watchGithubCi(cwd: string, limit = 3): GithubCiSnapshot {
  if (!ghAvailable()) {
    return {
      available: false,
      runs: [],
      summary: "GitHub CI watch: gh CLI not available",
      error: "gh not installed",
    };
  }

  const branch = safeGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) {
    return {
      available: false,
      runs: [],
      summary: "GitHub CI watch: not a git repo",
      error: "no branch",
    };
  }

  try {
    const raw = execFileSync(
      "gh",
      [
        "run",
        "list",
        "--branch",
        branch,
        "--limit",
        String(limit),
        "--json",
        "databaseId,status,conclusion,displayTitle,url,event,createdAt",
      ],
      { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const runs = parseRuns(raw);
    return {
      available: true,
      branch,
      runs,
      summary: summarizeRuns(runs),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      branch,
      runs: [],
      summary: "GitHub CI watch failed",
      error: message.slice(0, 200),
    };
  }
}
