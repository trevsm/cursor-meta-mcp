import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import type { LocalAgentService, RunHooks } from "./cursor-local.js";
import { runConsciousnessPulse } from "./consciousness-pulse.js";
import { getChatById, getChatByIndex } from "./history-store.js";
import { loadSessionSummary, loadSessionSummaryById } from "./history.js";
import { isMetaDiscussion, isStrategySessionTitle } from "./meta-discussion.js";
import { defaultSuccessCriteria } from "./mission.js";
import { formatGitSyncStatusForPrompt, getGitSyncStatus } from "./git-sync.js";
import { formatWorldModelForPrompt, loadWorldModel, recentEpisodes } from "./world-model.js";

export interface StrategySpawnPlan {
  role: string;
  prompt: string;
}

export interface StrategyVerdict {
  onTrack: boolean;
  score: number;
  issues: string[];
  recommendation: string;
  pivot: string | null;
  spawn: StrategySpawnPlan | null;
  kill: number[];
}

export interface StrategyReviewParams {
  goal: string;
  cwd: string;
  successCriteria?: string[];
  sessionIndex?: number;
  sessionId?: string;
  workspace?: string;
  workerCheckpoints?: Array<{
    name: string;
    sessionIndex?: number;
    checkpointPath?: string;
  }>;
  useLlm?: boolean;
  model?: string;
}

export interface StrategyContext {
  goal: string;
  successCriteria: string[];
  cwd: string;
  gitDiffStat: string;
  gitSyncSummary: string;
  transcriptTail: string;
  pulseSummary: string;
  workerSummary: string;
  worldModelSummary: string;
  recentFailures: Array<{ context: string; reason: string }>;
}

export interface StrategyReviewResult {
  context: StrategyContext;
  verdict: StrategyVerdict;
  source: "heuristic" | "llm" | "heuristic+llm";
  reviewedAt: string;
}

const ARCHITECTURE_THEATER =
  /\b(architecture (essay|theater|discussion)|mental model|groundbreaking|change the world|vision doc|strategy review|honest assessment|dimensional meta)\b/i;

const CONCRETE_PROGRESS = /\b(npm test|tests pass|committed|implemented|fixed|added test|coverage)\b/i;

export function gitDiffStat(cwd: string): string {
  try {
    const stat = execFileSync("git", ["diff", "--stat", "HEAD"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 20_000,
    }).trim();
    if (stat) return stat;
    const staged = execFileSync("git", ["diff", "--cached", "--stat"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 20_000,
    }).trim();
    return staged || "(no uncommitted changes)";
  } catch {
    return "(git unavailable)";
  }
}

function summarizePulse(workspace?: string): string {
  try {
    const report = runConsciousnessPulse({ limit: 15, workspace });
    const lines = [
      `live=${report.live.length} frustration=${report.frustrationEvents.length} matrix=${report.orchestrationMatrix.length}`,
    ];
    for (const row of report.parallelWorkspaces.slice(0, 2)) {
      lines.push(`parallel ${row.workspace}: ${row.concurrentSessions} tabs`);
    }
    for (const entry of report.frustrationEvents.slice(0, 3)) {
      lines.push(
        `#${entry.sessionIndex ?? "?"} ${entry.title}: risk=${entry.frustrationRisk.score} ${entry.frustrationRisk.reason ?? ""}`,
      );
    }
    return lines.join("\n");
  } catch (error) {
    return `(pulse unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

function summarizeWorkers(
  checkpoints: StrategyReviewParams["workerCheckpoints"] = [],
): string {
  if (checkpoints.length === 0) return "(no worker checkpoints)";
  const lines: string[] = [];
  for (const worker of checkpoints) {
    if (!worker.checkpointPath || !existsSync(worker.checkpointPath)) {
      lines.push(`${worker.name} #${worker.sessionIndex ?? "?"}: no checkpoint`);
      continue;
    }
    try {
      const state = JSON.parse(readFileSync(worker.checkpointPath, "utf8")) as {
        ticks?: Array<{ error?: string; skipped?: string }>;
        stoppedBecause?: string;
      };
      const ticks = state.ticks ?? [];
      const errors = ticks.filter((tick) => tick.error && tick.skipped == null).length;
      const softSkips = ticks.filter((tick) => tick.skipped != null).length;
      const last = ticks.at(-1);
      lines.push(
        `${worker.name} #${worker.sessionIndex ?? "?"}: ticks=${ticks.length} errors=${errors} soft=${softSkips} stopped=${state.stoppedBecause ?? "running"} last=${last?.skipped ?? last?.error ?? "ok"}`,
      );
    } catch {
      lines.push(`${worker.name}: unreadable checkpoint`);
    }
  }
  return lines.join("\n");
}

async function loadTranscriptTail(
  sessionIndex?: number,
  sessionId?: string,
  maxMessages = 8,
): Promise<string> {
  try {
    if (sessionId) return await loadSessionSummaryById(sessionId, maxMessages);
    if (sessionIndex != null) return await loadSessionSummary(sessionIndex, maxMessages);
    return "(no session target — fleet-level review)";
  } catch (error) {
    return `(transcript unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

export function gatherStrategyContext(params: StrategyReviewParams): StrategyContext {
  const goal = params.goal.trim();
  const cwd = params.cwd.trim();
  const successCriteria =
    params.successCriteria?.filter((criterion) => criterion.trim()).length
      ? params.successCriteria.filter((criterion) => criterion.trim())
      : defaultSuccessCriteria();
  const workspaceHint = params.workspace ?? basename(cwd);
  const world = loadWorldModel();
  const episodes = recentEpisodes(undefined, 10);

  return {
    goal,
    successCriteria,
    cwd,
    gitDiffStat: gitDiffStat(cwd),
    gitSyncSummary: formatGitSyncStatusForPrompt(getGitSyncStatus(cwd)),
    transcriptTail: "", // filled async in runStrategyReview
    pulseSummary: summarizePulse(workspaceHint),
    workerSummary: summarizeWorkers(params.workerCheckpoints),
    worldModelSummary: formatWorldModelForPrompt(world, episodes),
    recentFailures: world.failures.slice(-5).map((row) => ({
      context: row.context,
      reason: row.reason,
    })),
  };
}

export function buildStrategyReviewPrompt(context: StrategyContext, transcriptTail: string): string {
  return [
    "You are a strategy critic (dimension 4) reviewing whether an agent fleet is working on the RIGHT problem.",
    "Judge strategy and direction — not output polish. Be harsh about architecture theater and meta-discussion loops.",
    "",
    "## Mission goal",
    context.goal,
    "",
    "## Success criteria",
    ...context.successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "",
    "## Git diff stat",
    context.gitDiffStat,
    "",
    "## Git sync",
    context.gitSyncSummary,
    "",
    "## Recent transcript",
    transcriptTail,
    "",
    "## Pulse summary",
    context.pulseSummary,
    "",
    "## Worker checkpoints",
    context.workerSummary,
    "",
    "## World model (persistent memory)",
    context.worldModelSummary || "(empty — no north star, goals, or episodes yet)",
    "",
    "Respond with ONLY valid JSON (no markdown fences):",
    '{"onTrack":boolean,"score":0-100,"issues":["..."],"recommendation":"...","pivot":string|null,"spawn":{"role":"...","prompt":"..."}|null,"kill":[sessionIndex,...]}',
    "",
    "Rules:",
    "- onTrack=true only when work clearly advances the mission with verified progress.",
    "- pivot: concrete new direction prompt when off-track (null if on-track).",
    "- spawn: optional parallel specialist when verification or exploration is needed (null otherwise).",
    "- kill: session indexes to stop/intercept when a branch is stale or harmful (empty array if none).",
    "- Reject meta-discussion, duplicate parallel work, and zero-diff architecture loops.",
  ].join("\n");
}

export function parseStrategyVerdict(text: string, approvalScore = 70): StrategyVerdict {
  const match = text.match(/\{[\s\S]*"onTrack"[\s\S]*?\}/);
  if (!match) {
    throw new Error(`Strategy review missing JSON verdict. Got: ${text.slice(0, 400)}`);
  }

  const parsed = JSON.parse(match[0]) as Partial<StrategyVerdict> & {
    spawn?: StrategySpawnPlan | null;
  };
  const score = typeof parsed.score === "number" ? parsed.score : 0;
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((item): item is string => typeof item === "string")
    : [];
  const recommendation =
    typeof parsed.recommendation === "string" ? parsed.recommendation.trim() : "";
  const pivot = typeof parsed.pivot === "string" && parsed.pivot.trim() ? parsed.pivot.trim() : null;
  const spawn =
    parsed.spawn &&
    typeof parsed.spawn === "object" &&
    typeof parsed.spawn.role === "string" &&
    typeof parsed.spawn.prompt === "string"
      ? { role: parsed.spawn.role.trim(), prompt: parsed.spawn.prompt.trim() }
      : null;
  const kill = Array.isArray(parsed.kill)
    ? parsed.kill.filter((item): item is number => typeof item === "number")
    : [];
  const onTrack = parsed.onTrack === true && score >= approvalScore;

  return { onTrack, score, issues, recommendation, pivot, spawn, kill };
}

function recentUserTexts(sessionIndex?: number, sessionId?: string): string[] {
  try {
    const session = sessionId ? getChatById(sessionId) : getChatByIndex(sessionIndex!);
    return session.messages
      .filter((message) => message.role === "user")
      .slice(-4)
      .map((message) => message.content.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sessionTitle(sessionIndex?: number, sessionId?: string): string {
  try {
    const session = sessionId ? getChatById(sessionId) : getChatByIndex(sessionIndex!);
    return session.title;
  } catch {
    return "";
  }
}

/** Fast offline strategy review — no model call. Used by fleet watcher between LLM passes. */
export function heuristicStrategyReview(
  context: StrategyContext,
  transcriptTail: string,
  opts: { sessionIndex?: number; sessionId?: string } = {},
): StrategyVerdict {
  const issues: string[] = [];
  let score = 75;
  const userTexts = recentUserTexts(opts.sessionIndex, opts.sessionId);
  const title = sessionTitle(opts.sessionIndex, opts.sessionId);
  const kill: number[] = [];
  let pivot: string | null = null;
  let spawn: StrategySpawnPlan | null = null;

  if (isStrategySessionTitle(title)) {
    score -= 25;
    issues.push("strategy_session_title");
  }

  const metaRecent = userTexts.filter((text) => isMetaDiscussion(text)).length;
  if (metaRecent >= 2) {
    score -= 30;
    issues.push("meta_discussion_loop");
    pivot =
      "Stop meta-discussion. Pick ONE concrete code improvement, implement it, run npm test, report diff only.";
  } else if (userTexts.some((text) => isMetaDiscussion(text))) {
    score -= 15;
    issues.push("meta_discussion");
  }

  if (ARCHITECTURE_THEATER.test(transcriptTail) && !CONCRETE_PROGRESS.test(transcriptTail)) {
    score -= 25;
    issues.push("architecture_theater");
    pivot =
      pivot ??
      "No more architecture. Ship one verified improvement: fix a test, tighten a heuristic, or close a coverage gap.";
  }

  if (context.gitDiffStat === "(no uncommitted changes)" && !CONCRETE_PROGRESS.test(transcriptTail)) {
    score -= 20;
    issues.push("no_code_progress");
  }

  const gitStatus = getGitSyncStatus(context.cwd);
  if (gitStatus.available && gitStatus.dirty && CONCRETE_PROGRESS.test(transcriptTail)) {
    score -= 15;
    issues.push("uncommitted_work");
    pivot =
      pivot ??
      "Tests passed but work is uncommitted. Stage only your changes (skip .env and .tmp-*), commit with a clear message, then push.";
  }

  if (gitStatus.available && gitStatus.unpushed) {
    score -= 10;
    issues.push("unpushed_commits");
    pivot =
      pivot ??
      `Push ${gitStatus.ahead} local commit(s) to origin/${gitStatus.branch} before starting new features.`;
  }

  if (/parallel .+: [3-9]\d* tabs/.test(context.pulseSummary)) {
    score -= 15;
    issues.push("fragmented_parallel_tabs");
    spawn = {
      role: "verifier",
      prompt:
        "Independent verifier: read git diff and run npm test. Report blockers only — do not start new features.",
    };
  }

  const failures = context.recentFailures.slice(-3);
  if (failures.length >= 2 && failures.every((row) => row.context === failures[0]?.context)) {
    score -= 15;
    issues.push("repeated_failure");
    pivot =
      pivot ??
      `Same failure repeated (${failures[0]?.context}): change approach — consult world model skills or pivot task.`;
  }

  const staleWorkers = context.workerSummary
    .split("\n")
    .filter((line) => /errors=[3-9]\d*|stopped=(error|consecutive_errors)/.test(line));
  if (staleWorkers.length > 0) {
    score -= 20;
    issues.push("stale_workers");
    for (const line of staleWorkers) {
      const match = /#(\d+)/.exec(line);
      if (match) kill.push(Number(match[1]));
    }
    pivot =
      pivot ??
      "Relaunch or intercept dead/errored workers. Prefer soft-skip resilience for missing sessions; keep shipping verified code.";
  }

  const onTrack = score >= 70 && issues.length === 0;
  const recommendation = onTrack
    ? "Continue current direction — verified progress detected."
    : issues.includes("meta_discussion_loop")
      ? "Pivot out of meta-discussion into concrete shipping work."
      : issues.includes("architecture_theater")
        ? "Pivot from architecture to one small verified diff."
        : issues.includes("no_code_progress")
          ? "Force a code change with npm test verification this tick."
          : issues.includes("uncommitted_work")
            ? "Commit verified changes before starting new work."
            : issues.includes("unpushed_commits")
              ? "Push local commits to origin before starting new work."
              : "Adjust fleet topology or worker prompts.";

  return {
    onTrack,
    score: Math.max(0, Math.min(100, score)),
    issues,
    recommendation,
    pivot: onTrack ? null : pivot,
    spawn: onTrack ? null : spawn,
    kill,
  };
}

export async function runStrategyReview(
  service: LocalAgentService | undefined,
  params: StrategyReviewParams,
  hooks?: RunHooks,
): Promise<StrategyReviewResult> {
  if (!params.goal.trim()) throw new Error("goal is required.");
  if (!params.cwd.trim()) throw new Error("cwd is required.");

  const context = gatherStrategyContext(params);
  const transcriptTail = await loadTranscriptTail(params.sessionIndex, params.sessionId);
  context.transcriptTail = transcriptTail;

  const heuristic = heuristicStrategyReview(context, transcriptTail, {
    sessionIndex: params.sessionIndex,
    sessionId: params.sessionId,
  });

  if (!params.useLlm || !service) {
    return {
      context,
      verdict: heuristic,
      source: "heuristic",
      reviewedAt: new Date().toISOString(),
    };
  }

  const prompt = buildStrategyReviewPrompt(context, transcriptTail);
  const run = await service.runLocalAgent(
    {
      prompt,
      cwd: params.cwd,
      model: params.model,
      mode: "ask",
      name: "strategy-critic",
    },
    hooks,
  );

  const llmVerdict = parseStrategyVerdict(run.result);
  const merged: StrategyVerdict = {
    onTrack: llmVerdict.onTrack && heuristic.onTrack,
    score: Math.min(llmVerdict.score, heuristic.score),
    issues: [...new Set([...heuristic.issues, ...llmVerdict.issues])],
    recommendation: llmVerdict.recommendation || heuristic.recommendation,
    pivot: llmVerdict.pivot ?? heuristic.pivot,
    spawn: llmVerdict.spawn ?? heuristic.spawn,
    kill: [...new Set([...heuristic.kill, ...llmVerdict.kill])],
  };

  return {
    context,
    verdict: merged,
    source: "heuristic+llm",
    reviewedAt: new Date().toISOString(),
  };
}

export const DEFAULT_SELF_IMPROVE_GOAL =
  "Autonomously improve this codebase: fix bugs, add tests, tighten heuristics, reduce false-positive orchestration.";

export const DEFAULT_SELF_IMPROVE_CRITERIA = [
  "Each worker ships small verified diffs — npm test passes before claiming done.",
  "Verified diffs are committed and pushed — origin stays current.",
  "No architecture theater or meta-discussion loops.",
  "Workers avoid duplicating the same stuck task across parallel tabs.",
  "Orchestrator keeps fleet moving without touching the conductor session.",
];
