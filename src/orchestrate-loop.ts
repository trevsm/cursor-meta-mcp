import type { LocalAgentService } from "./cursor-local.js";
import {
  orchestratePulse,
  type ExecutedAction,
  type OrchestratePulseParams,
  type OrchestratePulseResult,
} from "./orchestrate-pulse.js";

export interface OrchestrateLoopParams extends OrchestratePulseParams {
  maxCycles?: number;
  intervalMs?: number;
  stopWhenIdle?: boolean;
}

export interface OrchestrateLoopCycle {
  cycle: number;
  at: string;
  liveCount: number;
  matrixCount: number;
  executedCount: number;
  errorCount: number;
  result: OrchestratePulseResult;
}

export interface OrchestrateLoopResult {
  cycles: number;
  stoppedBecause: "max_cycles" | "idle" | "errors" | "no_work";
  history: OrchestrateLoopCycle[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function orchestrateLoop(
  params: OrchestrateLoopParams = {},
  service?: LocalAgentService,
  runOrchestrate: (
    params: OrchestratePulseParams,
    service?: LocalAgentService,
  ) => Promise<OrchestratePulseResult> = orchestratePulse,
): Promise<OrchestrateLoopResult> {
  const maxCycles = params.maxCycles ?? 8;
  const intervalMs = params.intervalMs ?? 45_000;
  const stopWhenIdle = params.stopWhenIdle ?? true;
  const history: OrchestrateLoopCycle[] = [];

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const result = await runOrchestrate(params, service);
    const matrixCount = result.pulse.orchestrationMatrix.length;
    const executedCount = result.executed.length;
    const errorCount = result.executed.filter((action) => action.error).length;

    history.push({
      cycle,
      at: new Date().toISOString(),
      liveCount: result.pulse.live.length,
      matrixCount,
      executedCount,
      errorCount,
      result,
    });

    if (errorCount > 0 && executedCount > 0 && errorCount === executedCount) {
      return { cycles: cycle, stoppedBecause: "errors", history };
    }

    if (stopWhenIdle && matrixCount === 0) {
      return { cycles: cycle, stoppedBecause: "idle", history };
    }

    if (matrixCount > 0 && executedCount === 0) {
      return { cycles: cycle, stoppedBecause: "no_work", history };
    }

    if (cycle < maxCycles) {
      await sleep(intervalMs);
    }
  }

  return { cycles: maxCycles, stoppedBecause: "max_cycles", history };
}

export function summarizeLoop(result: OrchestrateLoopResult): {
  totalExecuted: number;
  totalErrors: number;
  actions: ExecutedAction[];
} {
  const actions = result.history.flatMap((cycle) => cycle.result.executed);
  return {
    totalExecuted: actions.length,
    totalErrors: actions.filter((action) => action.error).length,
    actions,
  };
}

export { filterOrchestrationMatrix as filterExcludedSessions } from "./orchestrate-pulse.js";
