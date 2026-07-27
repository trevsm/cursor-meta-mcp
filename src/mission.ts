import type { LocalAgentService, RunHooks } from "./cursor-local.js";
import {
  runRelentlessLoop,
  type RelentlessLoopParams,
  type RelentlessLoopResult,
} from "./relentless-loop.js";

export interface MissionParams {
  goal: string;
  successCriteria?: string[];
  cwd: string;
  target?: RelentlessLoopParams["target"];
  sessionIndex?: number;
  sessionId?: string;
  maxIterations?: number;
  approvalScore?: number;
  model?: string;
  mode?: RelentlessLoopParams["mode"];
  pollIntervalMs?: number;
  idleStableMs?: number;
  waitTimeoutMs?: number;
}

export interface MissionResult extends RelentlessLoopResult {
  mission: {
    goal: string;
    successCriteria: string[];
    startedAt: string;
    completedAt: string;
  };
}

const DEFAULT_SUCCESS_CRITERIA = [
  "The goal is fully satisfied without hand-waving or deferred work.",
  "Changes are verified (tests, typecheck, lint, or an explicit runtime check).",
  "The solution is minimal — no unrelated edits or scope creep.",
];

export function defaultSuccessCriteria(): string[] {
  return [...DEFAULT_SUCCESS_CRITERIA];
}

export function buildMissionTask(goal: string, successCriteria: string[]): string {
  return [
    "## Mission goal",
    goal.trim(),
    "",
    "## Success criteria (all required)",
    ...successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "",
    "Do not stop until every criterion is met and verified.",
  ].join("\n");
}

export function buildMissionRubric(successCriteria: string[]): string {
  return [
    "Mission success requires ALL of the following:",
    ...successCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Reject if any criterion is unmet, unverified, or only partially addressed.",
  ].join("\n");
}

export async function runMission(
  service: LocalAgentService,
  params: MissionParams,
  hooks?: RunHooks,
): Promise<MissionResult> {
  if (!params.goal.trim()) {
    throw new Error("goal is required.");
  }
  if (!params.cwd.trim()) {
    throw new Error("cwd is required.");
  }

  const successCriteria =
    params.successCriteria?.filter((criterion) => criterion.trim()).length
      ? params.successCriteria.filter((criterion) => criterion.trim())
      : defaultSuccessCriteria();

  const startedAt = new Date().toISOString();
  const loop = await runRelentlessLoop(
    service,
    {
      task: buildMissionTask(params.goal, successCriteria),
      cwd: params.cwd,
      rubric: buildMissionRubric(successCriteria),
      target: params.target,
      sessionIndex: params.sessionIndex,
      sessionId: params.sessionId,
      maxIterations: params.maxIterations,
      approvalScore: params.approvalScore,
      model: params.model,
      mode: params.mode,
      pollIntervalMs: params.pollIntervalMs,
      idleStableMs: params.idleStableMs,
      waitTimeoutMs: params.waitTimeoutMs,
    },
    hooks,
  );

  return {
    ...loop,
    mission: {
      goal: params.goal.trim(),
      successCriteria,
      startedAt,
      completedAt: new Date().toISOString(),
    },
  };
}
