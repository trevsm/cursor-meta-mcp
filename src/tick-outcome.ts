import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Verified result of one worker tick.
 *
 * Timing and skip reasons say whether the loop is alive; only these fields say
 * whether it accomplished anything. Without them an improving fleet and a
 * spinning one look identical in the ledger.
 */
export interface TickOutcome {
  headBefore?: string;
  headAfter?: string;
  committed: boolean;
  /** True when this tick reduced commits ahead of origin (including commit+push from synced). */
  pushed: boolean;
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  dirtyFiles: number;
  tests?: TestOutcome;
  /** True when the tick changed tracked files or produced a commit. */
  producedWork: boolean;
}

export interface TestOutcome {
  ran: boolean;
  passed: boolean;
  total?: number;
  failed?: number;
  durationMs: number;
  command: string;
  summary?: string;
}

export interface RepoSnapshot {
  head?: string;
  dirtyFiles: number;
  /**
   * Fingerprint of dirty work: porcelain paths, tracked diff vs HEAD, and
   * content hashes for untracked files (porcelain alone misses content edits).
   */
  dirtyFingerprint: string;
  /** Commits ahead of origin/<branch>; undefined when no upstream. */
  aheadOfUpstream?: number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1_000_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function safeGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

function porcelainPath(line: string): string | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed) return undefined;
  const renamed = trimmed.includes(" -> ") ? trimmed.split(" -> ").at(-1) : undefined;
  const raw = (renamed ?? trimmed.slice(3)).trim();
  return raw.replace(/^"(.*)"$/, "$1") || undefined;
}

function untrackedContentFingerprint(cwd: string, porcelain: string): string {
  const hashes: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("??") && !line.startsWith("!!")) continue;
    const rel = porcelainPath(line);
    if (!rel) continue;
    try {
      const body = readFileSync(join(cwd, rel));
      hashes.push(`${rel}:${createHash("sha1").update(body).digest("hex")}`);
    } catch {
      hashes.push(`${rel}:missing`);
    }
  }
  return hashes.sort().join("\n");
}

function aheadOfUpstream(cwd: string): number | undefined {
  const branch = safeGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return undefined;
  const counts = safeGit(cwd, ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`]);
  if (counts === undefined) return undefined;
  const parts = counts.split(/\s+/);
  return Number(parts[1]) || 0;
}

export function captureRepoSnapshot(cwd: string): RepoSnapshot {
  const head = safeGit(cwd, ["rev-parse", "HEAD"]);
  const porcelain = safeGit(cwd, ["status", "--porcelain"]) ?? "";
  const diff = safeGit(cwd, ["diff", "HEAD"]) ?? "";
  const untracked = untrackedContentFingerprint(cwd, porcelain);
  return {
    head,
    dirtyFiles: porcelain.split("\n").filter((line) => line.trim().length > 0).length,
    dirtyFingerprint: `${porcelain}\n${diff}\n${untracked}`,
    aheadOfUpstream: aheadOfUpstream(cwd),
  };
}

/** Parse `git diff --shortstat` output, e.g. "3 files changed, 40 insertions(+), 2 deletions(-)". */
export function parseShortstat(raw: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const files = /(\d+) files? changed/.exec(raw);
  const ins = /(\d+) insertions?\(\+\)/.exec(raw);
  const del = /(\d+) deletions?\(-\)/.exec(raw);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/** Parse the counters `node --test` prints, so we record pass/fail rather than just exit code. */
export function parseNodeTestSummary(output: string): { total?: number; failed?: number } {
  const total = /^#\s*tests\s+(\d+)$/m.exec(output);
  const failed = /^#\s*fail\s+(\d+)$/m.exec(output);
  return {
    total: total ? Number(total[1]) : undefined,
    failed: failed ? Number(failed[1]) : undefined,
  };
}

export interface RunTestsParams {
  cwd: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export const FAST_TEST_COMMAND = "npm";
export const FAST_TEST_ARGS = ["run", "--silent", "test:fast"];

/**
 * Run the fast (no-coverage) suite for inner-loop verification. The full coverage
 * gate stays in `npm test` for pre-commit and CI.
 */
export function runTests(params: RunTestsParams): TestOutcome {
  const command = params.command ?? FAST_TEST_COMMAND;
  const args = params.args ?? FAST_TEST_ARGS;
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: params.cwd,
    encoding: "utf8",
    timeout: params.timeoutMs ?? 5 * 60_000,
    maxBuffer: 20_000_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const counts = parseNodeTestSummary(output);
  const failedLine = /^#\s*fail\s+\d+$/m.exec(output)?.[0];

  return {
    ran: true,
    passed: result.status === 0 && (counts.failed ?? 0) === 0,
    total: counts.total,
    failed: counts.failed,
    durationMs: Date.now() - startedAt,
    command: [command, ...args].join(" "),
    summary: failedLine ?? (result.error ? String(result.error.message) : undefined),
  };
}

export interface SummarizeTickParams {
  cwd: string;
  before: RepoSnapshot;
  /** Run tests only when the tick actually touched the repo. May return undefined to skip. */
  verify?: (cwd: string) => TestOutcome | undefined;
}

export function summarizeTickOutcome(params: SummarizeTickParams): TickOutcome {
  const after = captureRepoSnapshot(params.cwd);
  const headBefore = params.before.head;
  const headAfter = after.head;
  const committed = Boolean(headBefore && headAfter && headBefore !== headAfter);

  let commits = 0;
  let stat = { filesChanged: 0, insertions: 0, deletions: 0 };

  if (committed && headBefore && headAfter) {
    const count = safeGit(params.cwd, ["rev-list", "--count", `${headBefore}..${headAfter}`]);
    commits = count ? Number(count) || 0 : 0;
    stat = parseShortstat(safeGit(params.cwd, ["diff", "--shortstat", headBefore, headAfter]) ?? "");
  } else {
    stat = parseShortstat(safeGit(params.cwd, ["diff", "--shortstat", "HEAD"]) ?? "");
  }

  const producedWork =
    committed ||
    stat.filesChanged > 0 ||
    after.dirtyFiles > params.before.dirtyFiles ||
    after.dirtyFingerprint !== params.before.dirtyFingerprint;

  const aheadBefore = params.before.aheadOfUpstream;
  const aheadAfter = after.aheadOfUpstream;
  const pushed =
    typeof aheadAfter === "number" &&
    aheadAfter === 0 &&
    ((typeof aheadBefore === "number" && aheadBefore > 0) ||
      (committed && typeof aheadBefore === "number"));

  return {
    headBefore,
    headAfter,
    committed,
    pushed,
    commits,
    filesChanged: stat.filesChanged,
    insertions: stat.insertions,
    deletions: stat.deletions,
    dirtyFiles: after.dirtyFiles,
    producedWork,
    tests: producedWork && params.verify ? params.verify(params.cwd) : undefined,
  };
}

export function describeTickOutcome(outcome: TickOutcome | undefined): string {
  if (!outcome) return "no outcome recorded";
  if (!outcome.producedWork) return "no repo change";
  const parts: string[] = [];
  if (outcome.committed) parts.push(`${outcome.commits} commit(s)`);
  if (outcome.pushed) parts.push("pushed");
  parts.push(`${outcome.filesChanged} file(s) +${outcome.insertions}/-${outcome.deletions}`);
  if (outcome.tests) {
    parts.push(
      outcome.tests.passed
        ? `tests pass (${outcome.tests.total ?? "?"})`
        : `TESTS FAIL (${outcome.tests.failed ?? "?"} failing)`,
    );
  }
  return parts.join(", ");
}
