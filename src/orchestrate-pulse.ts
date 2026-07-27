import type { LocalAgentService } from "./cursor-local.js";
import {
  runConsciousnessPulse,
  type ConsciousnessPulseParams,
  type ConsciousnessPulseReport,
  type OrchestrationAction,
  type OrchestrationPlay,
  type PulseSessionEntry,
} from "./consciousness-pulse.js";
import { interceptIdeChat } from "./ide-chat-control.js";
import { watchIdeChat } from "./watch-chat.js";

export interface OrchestratePulseParams extends ConsciousnessPulseParams {
  dryRun?: boolean;
  allowWatch?: boolean;
  allowContinue?: boolean;
  allowIntercept?: boolean;
  allowSpawn?: boolean;
  maxActions?: number;
  pollIntervalMs?: number;
  idleStableMs?: number;
  timeoutMs?: number;
  excludeSessionIds?: string[];
  excludeSessionIndexes?: number[];
}

export interface ExecutedAction {
  sessionId: string;
  sessionIndex?: number;
  title: string;
  workspace: string;
  action: OrchestrationAction;
  tool: string;
  why: string;
  dryRun: boolean;
  result?: unknown;
  error?: string;
}

export interface OrchestratePulseResult {
  pulse: ConsciousnessPulseReport;
  planned: number;
  executed: ExecutedAction[];
  skipped: Array<{
    sessionId: string;
    title: string;
    action: OrchestrationAction;
    reason: string;
  }>;
}

const ACTION_PRIORITY: Record<OrchestrationAction, number> = {
  INTERCEPT: 0,
  CONTINUE: 1,
  WATCH: 2,
  SPAWN_SPECIALIST: 3,
};

function isAllowed(action: OrchestrationAction, params: OrchestratePulseParams): boolean {
  switch (action) {
    case "WATCH":
      return params.allowWatch ?? true;
    case "CONTINUE":
      return params.allowContinue ?? true;
    case "INTERCEPT":
      return params.allowIntercept ?? false;
    case "SPAWN_SPECIALIST":
      return params.allowSpawn ?? false;
    default:
      return false;
  }
}

export function selectPlaysForSession(
  entry: PulseSessionEntry & { plays: OrchestrationPlay[] },
  params: OrchestratePulseParams,
): OrchestrationPlay[] {
  return [...entry.plays]
    .filter((play) => isAllowed(play.action, params))
    .sort((a, b) => ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action]);
}

export async function executeOrchestrationPlay(
  entry: PulseSessionEntry & { plays: OrchestrationPlay[] },
  play: OrchestrationPlay,
  params: OrchestratePulseParams,
  service?: LocalAgentService,
): Promise<ExecutedAction> {
  const base: ExecutedAction = {
    sessionId: entry.sessionId,
    sessionIndex: entry.sessionIndex,
    title: entry.title,
    workspace: entry.workspace,
    action: play.action,
    tool: play.tool,
    why: play.why,
    dryRun: params.dryRun ?? false,
  };

  if (base.dryRun) {
    return base;
  }

  const cwd = entry.workspace === "unknown" ? params.workspace : entry.workspace;
  if (!cwd || cwd === "unknown") {
    return { ...base, error: "Workspace unknown — pass workspace filter or cwd." };
  }

  try {
    switch (play.action) {
      case "WATCH":
        return {
          ...base,
          result: await watchIdeChat({
            sessionId: entry.sessionId,
            followUpPrompt: play.prompt,
            cwd,
            pollIntervalMs: params.pollIntervalMs,
            idleStableMs: params.idleStableMs,
            timeoutMs: params.timeoutMs,
            sendIfAlreadyIdle: Boolean(play.prompt),
          }),
        };
      case "CONTINUE":
        if (!play.prompt) {
          return { ...base, error: "CONTINUE play missing prompt." };
        }
        return {
          ...base,
          result: await watchIdeChat({
            sessionId: entry.sessionId,
            followUpPrompt: play.prompt,
            cwd,
            pollIntervalMs: params.pollIntervalMs,
            idleStableMs: params.idleStableMs,
            timeoutMs: params.timeoutMs,
          }),
        };
      case "INTERCEPT":
        if (!play.prompt) {
          return { ...base, error: "INTERCEPT play missing prompt." };
        }
        return {
          ...base,
          result: await interceptIdeChat({
            sessionId: entry.sessionId,
            prompt: play.prompt,
            cwd,
            abortFirst: true,
          }),
        };
      case "SPAWN_SPECIALIST":
        if (!service) {
          return { ...base, error: "SPAWN_SPECIALIST requires SDK agent service (CURSOR_API_KEY)." };
        }
        if (!play.prompt) {
          return { ...base, error: "SPAWN_SPECIALIST play missing prompt." };
        }
        return {
          ...base,
          result: await service.runLocalAgent({
            prompt: play.prompt,
            cwd,
            mode: "agent",
            name: `pulse-verifier-${entry.sessionIndex ?? entry.sessionId.slice(0, 8)}`,
          }),
        };
      default:
        return { ...base, error: `Unsupported action: ${play.action}` };
    }
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function filterOrchestrationMatrix(
  matrix: Array<PulseSessionEntry & { plays: OrchestrationPlay[] }>,
  params: Pick<OrchestratePulseParams, "excludeSessionIds" | "excludeSessionIndexes">,
): Array<PulseSessionEntry & { plays: OrchestrationPlay[] }> {
  const excludedIds = new Set(params.excludeSessionIds ?? []);
  const excludedIndexes = new Set(params.excludeSessionIndexes ?? []);
  return matrix.filter((entry) => {
    if (excludedIds.has(entry.sessionId)) return false;
    if (entry.sessionIndex != null && excludedIndexes.has(entry.sessionIndex)) return false;
    return true;
  });
}

export async function orchestratePulse(
  params: OrchestratePulseParams = {},
  service?: LocalAgentService,
): Promise<OrchestratePulseResult> {
  const pulse = runConsciousnessPulse(params);
  const matrix = filterOrchestrationMatrix(pulse.orchestrationMatrix, params);
  const filteredPulse = {
    ...pulse,
    orchestrationMatrix: matrix,
    live: pulse.live.filter(
      (entry) =>
        !params.excludeSessionIds?.includes(entry.sessionId) &&
        !(entry.sessionIndex != null && params.excludeSessionIndexes?.includes(entry.sessionIndex)),
    ),
  };
  const maxActions = params.maxActions ?? 3;
  const executed: ExecutedAction[] = [];
  const skipped: OrchestratePulseResult["skipped"] = [];
  let planned = 0;

  for (const entry of matrix) {
    const candidates = selectPlaysForSession(entry, params);
    if (candidates.length === 0) {
      for (const play of entry.plays) {
        skipped.push({
          sessionId: entry.sessionId,
          title: entry.title,
          action: play.action,
          reason: `Action ${play.action} not allowed by params.`,
        });
      }
      continue;
    }

    planned += 1;
    if (executed.length >= maxActions) {
      skipped.push({
        sessionId: entry.sessionId,
        title: entry.title,
        action: candidates[0].action,
        reason: `maxActions (${maxActions}) reached.`,
      });
      continue;
    }

    const play = candidates[0];
    executed.push(await executeOrchestrationPlay(entry, play, params, service));
  }

  return { pulse: filteredPulse, planned, executed, skipped };
}
