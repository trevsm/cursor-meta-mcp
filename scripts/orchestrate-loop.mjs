#!/usr/bin/env node
/**
 * Orchestrate Loop CLI — continuous pulse → execute cycles.
 *
 * Usage:
 *   node scripts/orchestrate-loop.mjs --dry-run --workspace cursor-meta-mcp --exclude-session 1
 *   node scripts/orchestrate-loop.mjs --workspace cursor-meta-mcp --max-cycles 3 --exclude-session 1
 */
import { CursorLocalService } from "../src/cursor-local.js";
import { orchestrateLoop, summarizeLoop } from "../src/orchestrate-loop.js";
import { acquireLockWithCleanup } from "../src/process-lock.js";

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (!flag("--no-lock")) {
  const lock = acquireLockWithCleanup("orchestrator-loop", argValue("--meta-dir"));
  if (!lock.acquired) {
    console.error(
      JSON.stringify({
        event: "orchestrator_loop_already_running",
        heldByPid: lock.heldBy?.pid,
        lockPath: lock.path,
      }),
    );
    process.exit(0);
  }
}

const excludeRaw = argValue("--exclude-session");
const params = {
  limit: argValue("--limit") ? Number(argValue("--limit")) : undefined,
  workspace: argValue("--workspace"),
  dryRun: flag("--dry-run"),
  allowIntercept: flag("--allow-intercept") || undefined,
  allowSpawn: flag("--allow-spawn") || undefined,
  maxActions: argValue("--max-actions") ? Number(argValue("--max-actions")) : undefined,
  maxCycles: argValue("--max-cycles") ? Number(argValue("--max-cycles")) : 3,
  intervalMs: argValue("--interval-ms") ? Number(argValue("--interval-ms")) : 15_000,
  stopWhenIdle: !flag("--keep-running"),
  allowContinue: flag("--allow-continue") || undefined,
  allowWatch: flag("--allow-watch") || undefined,
  excludeSessionIndexes: excludeRaw ? [Number(excludeRaw)] : undefined,
};

const service = new CursorLocalService({ apiKey: process.env.CURSOR_API_KEY });
const result = await orchestrateLoop(params, service);
const summary = summarizeLoop(result);

console.log(
  JSON.stringify(
    {
      stoppedBecause: result.stoppedBecause,
      cycles: result.cycles,
      totalExecuted: summary.totalExecuted,
      totalErrors: summary.totalErrors,
      history: result.history.map((cycle) => ({
        cycle: cycle.cycle,
        matrixCount: cycle.matrixCount,
        executedCount: cycle.executedCount,
        errorCount: cycle.errorCount,
        titles: cycle.result.executed.map((action) => ({
          title: action.title,
          action: action.action,
          error: action.error,
        })),
      })),
    },
    null,
    2,
  ),
);

process.exit(summary.totalErrors > 0 ? 1 : 0);
