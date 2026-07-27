#!/usr/bin/env node
/**
 * Long session CLI — keep an IDE chat running for a wall-clock duration.
 *
 * Usage:
 *   node scripts/long-session.mjs --session 1 --cwd /path/to/project --duration 30m
 *   node scripts/long-session.mjs --session-id UUID --cwd . --duration 2h --max-ticks 200
 *   node scripts/long-session.mjs --session 1 --cwd . --duration 10m --prompt "Keep improving tests"
 */
import { readFileSync } from "node:fs";

import { parseDurationMs, runLongSession, summarizeLongSession } from "../src/long-session.js";

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const durationMs = argValue("--duration") ? parseDurationMs(argValue("--duration")) : parseDurationMs("10m");
const sessionIndexRaw = argValue("--session");
const sessionId = argValue("--session-id");
const cwd = argValue("--cwd") ?? process.cwd();
const promptFile = argValue("--prompt-file");
const prompt =
  promptFile != null
    ? readFileSync(promptFile, "utf8").trim()
    : argValue("--prompt");

if (sessionIndexRaw == null && !sessionId) {
  console.error("Provide --session N or --session-id UUID.");
  process.exit(2);
}

const params = {
  cwd,
  sessionIndex: sessionIndexRaw != null ? Number(sessionIndexRaw) : undefined,
  sessionId,
  durationMs,
  maxTicks: argValue("--max-ticks") ? Number(argValue("--max-ticks")) : undefined,
  tickIntervalMs: argValue("--tick-interval") ? parseDurationMs(argValue("--tick-interval")) : undefined,
  waitTimeoutMs: argValue("--wait-timeout") ? parseDurationMs(argValue("--wait-timeout")) : undefined,
  pollIntervalMs: argValue("--poll-ms") ? Number(argValue("--poll-ms")) : undefined,
  idleStableMs: argValue("--idle-ms") ? Number(argValue("--idle-ms")) : undefined,
  checkpointPath: argValue("--checkpoint"),
  prompt,
  continueOnBusy: flag("--no-continue-on-busy") ? false : undefined,
  continueOnTimeout: flag("--no-continue-on-timeout") ? false : undefined,
  maxConsecutiveErrors: argValue("--max-consecutive-errors")
    ? Number(argValue("--max-consecutive-errors"))
    : undefined,
  metaDir: argValue("--meta-dir"),
  rebindOnMissing: flag("--no-rebind") ? false : undefined,
  rebindAfterMissing: argValue("--rebind-after") ? Number(argValue("--rebind-after")) : undefined,
};

console.error(
  JSON.stringify({
    event: "long_session_start",
    at: new Date().toISOString(),
    durationMs: params.durationMs,
    sessionIndex: params.sessionIndex,
    sessionId: params.sessionId,
    cwd: params.cwd,
  }),
);

params.onTick = (tick, state) => {
  console.error(
    JSON.stringify({
      event: "long_session_tick",
      tick: tick.tick,
      watchedMs: tick.watchedMs,
      wasAlreadyIdle: tick.wasAlreadyIdle,
      skipped: tick.skipped,
      error: tick.error,
      reboundTo: tick.reboundTo,
      outcome: tick.outcome
        ? {
            committed: tick.outcome.committed,
            commits: tick.outcome.commits,
            filesChanged: tick.outcome.filesChanged,
            producedWork: tick.outcome.producedWork,
            testsPassed: tick.outcome.tests?.passed,
          }
        : undefined,
      totalTicks: state.ticks.length,
    }),
  );
};

const result = await runLongSession(params);
const summary = summarizeLongSession(result);

console.log(
  JSON.stringify(
    {
      ...summary,
      stoppedBecause: result.stoppedBecause,
      elapsedMs: result.elapsedMs,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
    },
    null,
    2,
  ),
);

process.exit(result.stoppedBecause === "error" || result.stoppedBecause === "consecutive_errors" ? 1 : 0);
