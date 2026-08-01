import { isSelfImproveTarget } from "./fleet-target.js";

export interface CommitBatchPolicy {
  enabled: boolean;
  /** Minimum commits ahead of origin before a push is allowed. */
  minCommitsBeforePush: number;
  /** Minimum ticks since the last push when below minCommitsBeforePush. */
  minTicksBetweenPush: number;
  /** Minimum ticks between local commits (unless large-slice exception). */
  minTicksBetweenCommits: number;
  /** Large-slice commit allowed when verify is green and files changed >= this. */
  minFilesForCommit: number;
  /** Large-slice commit allowed when verify is green and line delta >= this. */
  minLinesForCommit: number;
  /** Prefer one commit per completed slice instead of every tick. */
  deferCommitUntilSliceGreen: boolean;
}

export interface BatchPolicyAudit {
  violations: string[];
  blocked: boolean;
  correctionPrompt?: string;
}

export interface BatchPolicyTick {
  tick?: number;
  outcome?: BatchTickOutcome;
}

export interface BatchTickOutcome {
  committed?: boolean;
  commits?: number;
  pushed?: boolean;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  tests?: { ran?: boolean; passed?: boolean };
}

const DEFAULT_MIN_COMMITS_BEFORE_PUSH = 3;
const DEFAULT_MIN_TICKS_BETWEEN_PUSH = 4;
const DEFAULT_MIN_TICKS_BETWEEN_COMMITS = 3;
const DEFAULT_MIN_FILES_FOR_COMMIT = 3;
const DEFAULT_MIN_LINES_FOR_COMMIT = 40;

export function resolveCommitBatchPolicy(cwd?: string): CommitBatchPolicy {
  const forceOn = process.env.CURSOR_META_BATCH_COMMITS === "1";
  const forceOff = process.env.CURSOR_META_BATCH_COMMITS === "0";
  const trimmed = cwd?.trim() ?? "";
  const externalTarget = trimmed.length > 0 && !isSelfImproveTarget(trimmed);
  const enabled = forceOn || (!forceOff && externalTarget);

  const minCommitsBeforePush = Number.parseInt(
    process.env.CURSOR_META_MIN_COMMITS_BEFORE_PUSH ?? String(DEFAULT_MIN_COMMITS_BEFORE_PUSH),
    10,
  );
  const minTicksBetweenPush = Number.parseInt(
    process.env.CURSOR_META_MIN_TICKS_BETWEEN_PUSH ?? String(DEFAULT_MIN_TICKS_BETWEEN_PUSH),
    10,
  );
  const minTicksBetweenCommits = Number.parseInt(
    process.env.CURSOR_META_MIN_TICKS_BETWEEN_COMMITS ?? String(DEFAULT_MIN_TICKS_BETWEEN_COMMITS),
    10,
  );
  const minFilesForCommit = Number.parseInt(
    process.env.CURSOR_META_MIN_FILES_FOR_COMMIT ?? String(DEFAULT_MIN_FILES_FOR_COMMIT),
    10,
  );
  const minLinesForCommit = Number.parseInt(
    process.env.CURSOR_META_MIN_LINES_FOR_COMMIT ?? String(DEFAULT_MIN_LINES_FOR_COMMIT),
    10,
  );

  return {
    enabled,
    minCommitsBeforePush: Number.isFinite(minCommitsBeforePush) ? minCommitsBeforePush : DEFAULT_MIN_COMMITS_BEFORE_PUSH,
    minTicksBetweenPush: Number.isFinite(minTicksBetweenPush) ? minTicksBetweenPush : DEFAULT_MIN_TICKS_BETWEEN_PUSH,
    minTicksBetweenCommits: Number.isFinite(minTicksBetweenCommits)
      ? minTicksBetweenCommits
      : DEFAULT_MIN_TICKS_BETWEEN_COMMITS,
    minFilesForCommit: Number.isFinite(minFilesForCommit) ? minFilesForCommit : DEFAULT_MIN_FILES_FOR_COMMIT,
    minLinesForCommit: Number.isFinite(minLinesForCommit) ? minLinesForCommit : DEFAULT_MIN_LINES_FOR_COMMIT,
    deferCommitUntilSliceGreen: true,
  };
}

export function defaultHonestFleetGoal(cwd?: string): string {
  const policy = resolveCommitBatchPolicy(cwd);
  if (!policy.enabled) {
    return "One verified diff per tick: verify → commit → push. Structured tick report required.";
  }
  return [
    "Autonomous worker on external repo — batch git to avoid CI spam.",
    "Verify each tick but keep changes uncommitted until a slice is fully green (test+lint).",
    `Commit at most once per ${policy.minTicksBetweenCommits}+ ticks unless the slice is large (${policy.minFilesForCommit}+ files).`,
    `Push only when ${policy.minCommitsBeforePush}+ commits are ready or ${policy.minTicksBetweenPush}+ ticks since last push.`,
    "Structured tick report required.",
  ].join(" ");
}

export function formatCommitBatchRulesForPrompt(policy: CommitBatchPolicy): string {
  if (!policy.enabled) {
    return ["Git batching: off — commit and push verified work each tick."].join(" ");
  }
  return [
    "Git batching: ON — do NOT git commit every tick.",
    "Work with an uncommitted tree across ticks until a slice is fully green (test+lint).",
    `Commit once per completed slice — wait ${policy.minTicksBetweenCommits}+ ticks between commits unless the diff is large (${policy.minFilesForCommit}+ files / ${policy.minLinesForCommit}+ lines).`,
    `Push only when ≥${policy.minCommitsBeforePush} commits are ready OR ≥${policy.minTicksBetweenPush} ticks passed since the last push.`,
  ].join(" ");
}

export function findLastPushTickIndex(ticks: BatchPolicyTick[]): number {
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    if (ticks[i]?.outcome?.pushed) return i;
  }
  return -1;
}

export function findLastCommitTickIndex(ticks: BatchPolicyTick[]): number {
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    if (ticks[i]?.outcome?.committed) return i;
  }
  return -1;
}

function verifyGreen(outcome: BatchTickOutcome | undefined): boolean {
  return !outcome?.tests?.ran || outcome.tests.passed === true;
}

function isLargeVerifiedSlice(outcome: BatchTickOutcome, policy: CommitBatchPolicy): boolean {
  if (!verifyGreen(outcome)) return false;
  const lineDelta = (outcome.insertions ?? 0) + (outcome.deletions ?? 0);
  return (
    (outcome.filesChanged ?? 0) >= policy.minFilesForCommit ||
    lineDelta >= policy.minLinesForCommit
  );
}

/** Block commits that would create one-commit-per-tick noise. */
export function auditBatchCommit(
  priorTicks: BatchPolicyTick[],
  outcome: BatchTickOutcome | undefined,
  policy: CommitBatchPolicy = resolveCommitBatchPolicy(),
  opts?: {
    /**
     * True when this tick verifiably completed its slice/mission (green tests
     * + honest done report). The policy is "commit once per completed slice" —
     * a small slice-completing commit is compliant, not churn.
     */
    sliceComplete?: boolean;
  },
): BatchPolicyAudit {
  if (!policy.enabled || !outcome?.committed) {
    return { violations: [], blocked: false };
  }

  if (policy.deferCommitUntilSliceGreen && !verifyGreen(outcome)) {
    return {
      violations: ["batch commit policy: committed before verify is fully green"],
      blocked: true,
      correctionPrompt: [
        "[Batch commit gate] Commit blocked — verify must be green first.",
        "- Keep working locally without committing until test AND lint pass.",
        "- Accumulate the full slice across ticks, then commit once.",
      ].join("\n"),
    };
  }

  const lastCommitIndex = findLastCommitTickIndex(priorTicks);
  const ticksSinceLastCommit =
    lastCommitIndex < 0 ? priorTicks.length : priorTicks.length - 1 - lastCommitIndex;

  if (ticksSinceLastCommit >= policy.minTicksBetweenCommits) {
    return { violations: [], blocked: false };
  }

  if (isLargeVerifiedSlice(outcome, policy)) {
    return { violations: [], blocked: false };
  }

  if (opts?.sliceComplete && verifyGreen(outcome)) {
    return { violations: [], blocked: false };
  }

  return {
    violations: [
      `batch commit policy: committed after only ${ticksSinceLastCommit} tick(s) since last commit — wait ${policy.minTicksBetweenCommits}+ ticks or finish a larger verified slice`,
    ],
    blocked: true,
    correctionPrompt: [
      "[Batch commit gate] Too many small standalone commits.",
      `- Need ${policy.minTicksBetweenCommits}+ ticks between commits, or ${policy.minFilesForCommit}+ files / ${policy.minLinesForCommit}+ lines with verify green.`,
      "- Keep changes uncommitted locally and continue this slice.",
      "- Do NOT git commit every tick.",
    ].join("\n"),
  };
}

/** Block pushes that would spam CI with one-commit-per-tick batches. */
export function auditBatchPush(
  priorTicks: BatchPolicyTick[],
  outcome: BatchTickOutcome | undefined,
  policy: CommitBatchPolicy = resolveCommitBatchPolicy(),
): BatchPolicyAudit {
  if (!policy.enabled || !outcome?.pushed) {
    return { violations: [], blocked: false };
  }

  const commitsThisPush = Math.max(1, outcome.commits ?? 1);
  if (commitsThisPush >= policy.minCommitsBeforePush) {
    return { violations: [], blocked: false };
  }

  const lastPushIndex = findLastPushTickIndex(priorTicks);
  const ticksSinceLastPush = lastPushIndex < 0 ? priorTicks.length : priorTicks.length - 1 - lastPushIndex;
  if (ticksSinceLastPush >= policy.minTicksBetweenPush) {
    return { violations: [], blocked: false };
  }

  return {
    violations: [
      `batch push policy: pushed ${commitsThisPush} commit(s) after only ${ticksSinceLastPush} tick(s) since last push — wait for ${policy.minCommitsBeforePush}+ commits or ${policy.minTicksBetweenPush}+ ticks`,
    ],
    blocked: true,
    correctionPrompt: [
      "[Batch push gate] Push blocked — this would trigger CI too often.",
      `- Need ${policy.minCommitsBeforePush}+ commits in the batch, or ${policy.minTicksBetweenPush}+ ticks since last push.`,
      "- Keep working locally without pushing. Commit only when a slice is fully green.",
    ].join("\n"),
  };
}

export function formatBatchGitReminder(
  ticks: BatchPolicyTick[],
  policy: CommitBatchPolicy = resolveCommitBatchPolicy(),
): string | undefined {
  if (!policy.enabled) return undefined;

  const lastCommitIndex = findLastCommitTickIndex(ticks);
  const ticksSinceCommit =
    lastCommitIndex < 0 ? ticks.length : ticks.length - 1 - lastCommitIndex;

  const lastPushIndex = findLastPushTickIndex(ticks);
  const ticksSincePush = lastPushIndex < 0 ? ticks.length : ticks.length - 1 - lastPushIndex;
  const commitsSincePush = ticks
    .slice(lastPushIndex + 1)
    .reduce((sum, tick) => sum + (tick.outcome?.commits ?? 0), 0);

  const lines = [
    `[Batch git] ${ticksSinceCommit}/${policy.minTicksBetweenCommits} ticks since last commit.`,
    "Keep working locally — do NOT commit this tick unless verify is green AND the slice is substantial.",
  ];

  if (commitsSincePush >= policy.minCommitsBeforePush) {
    lines.push(
      `[Batch push] ${commitsSincePush} commit(s) since last push — ok to push if verify is green.`,
    );
  } else {
    lines.push(
      `[Batch push] ${commitsSincePush}/${policy.minCommitsBeforePush} commits, ${ticksSincePush}/${policy.minTicksBetweenPush} ticks since last push — do not push yet.`,
    );
  }

  return lines.join(" ");
}

/** @deprecated use formatBatchGitReminder */
export function formatBatchPushReminder(
  ticks: BatchPolicyTick[],
  policy: CommitBatchPolicy = resolveCommitBatchPolicy(),
): string | undefined {
  return formatBatchGitReminder(ticks, policy);
}
