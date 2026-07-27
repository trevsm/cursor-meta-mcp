import { execFileSync, spawnSync } from "node:child_process";

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

export function captureRepoSnapshot(cwd: string): RepoSnapshot {
  const head = safeGit(cwd, ["rev-parse", "HEAD"]);
  const porcelain = safeGit(cwd, ["status", "--porcelain"]) ?? "";
  return {
    head,
    dirtyFiles: porcelain.split("\n").filter((line) => line.trim().length > 0).length,
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

  const producedWork = committed || stat.filesChanged > 0 || after.dirtyFiles > params.before.dirtyFiles;

  return {
    headBefore,
    headAfter,
    committed,
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
