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

import { runLongSession, summarizeLongSession } from "../dist/long-session.js";

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseDuration(raw) {
  if (!raw) return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${raw}. Use 30m, 2h, 90s, 600000ms.`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(amount * multipliers[unit]);
}

const durationMs = parseDuration(argValue("--duration")) ?? parseDuration("10m");
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
  tickIntervalMs: argValue("--tick-interval") ? parseDuration(argValue("--tick-interval")) : undefined,
  waitTimeoutMs: argValue("--wait-timeout") ? parseDuration(argValue("--wait-timeout")) : undefined,
  pollIntervalMs: argValue("--poll-ms") ? Number(argValue("--poll-ms")) : undefined,
  idleStableMs: argValue("--idle-ms") ? Number(argValue("--idle-ms")) : undefined,
  checkpointPath: argValue("--checkpoint"),
  prompt,
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
      error: tick.error,
      totalTicks: state.ticks.length,
    }),
  );
};

const result = await runLongSession(params);
const summary = summarizeLongSession(result, params.checkpointPath);

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

process.exit(result.stoppedBecause === "error" ? 1 : 0);
