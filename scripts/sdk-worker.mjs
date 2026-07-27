#!/usr/bin/env node
/**
 * Headless SDK worker — autonomous ticks without IDE tab lifecycle.
 *
 * Usage:
 *   node scripts/sdk-worker.mjs --cwd /path/to/project --duration 2h
 */
import { readFileSync } from "node:fs";

import { parseDurationMs } from "../src/long-session.js";
import { runSdkWorker, summarizeSdkWorker } from "../src/sdk-worker.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const promptFile = argValue("--prompt-file");
const prompt =
  promptFile != null ? readFileSync(promptFile, "utf8").trim() : argValue("--prompt");

const params = {
  cwd: argValue("--cwd") ?? process.cwd(),
  durationMs: argValue("--duration") ? parseDurationMs(argValue("--duration")) : undefined,
  maxTicks: argValue("--max-ticks") ? Number(argValue("--max-ticks")) : undefined,
  tickIntervalMs: argValue("--tick-interval") ? parseDurationMs(argValue("--tick-interval")) : undefined,
  checkpointPath: argValue("--checkpoint"),
  prompt,
  model: argValue("--model"),
  metaDir: argValue("--meta-dir"),
};

console.error(
  JSON.stringify({
    event: "sdk_worker_start",
    at: new Date().toISOString(),
    cwd: params.cwd,
    durationMs: params.durationMs,
  }),
);

params.onTick = (tick, state) => {
  console.error(
    JSON.stringify({
      event: "sdk_worker_tick",
      tick: tick.tick,
      watchedMs: tick.watchedMs,
      agentId: tick.agentId,
      error: tick.error,
      outcome: tick.outcome
        ? {
            committed: tick.outcome.committed,
            producedWork: tick.outcome.producedWork,
            testsPassed: tick.outcome.tests?.passed,
          }
        : undefined,
      totalTicks: state.ticks.length,
    }),
  );
};

const result = await runSdkWorker(params);
const summary = summarizeSdkWorker(result);

console.log(
  JSON.stringify(
    {
      ...summary,
      stoppedBecause: result.stoppedBecause,
      elapsedMs: result.elapsedMs,
      agentId: result.agentId,
    },
    null,
    2,
  ),
);

process.exit(result.stoppedBecause === "error" || result.stoppedBecause === "consecutive_errors" ? 1 : 0);
