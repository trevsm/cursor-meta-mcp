#!/usr/bin/env node
/**
 * Strategy review loop — dimension-4 critic for self-improve fleet.
 *
 * Usage:
 *   node scripts/strategy-review-loop.mjs --cwd /path/to/project --exclude-session 1
 *   node scripts/strategy-review-loop.mjs --interval 5m --use-llm
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { CursorLocalService } from "../src/cursor-local.js";
import { interceptIdeChat } from "../src/ide-chat-control.js";
import {
  DEFAULT_SELF_IMPROVE_CRITERIA,
  DEFAULT_SELF_IMPROVE_GOAL,
  runStrategyReview,
} from "../src/strategy-review.js";

const META_DIR = join(homedir(), ".cursor-meta", "experiments");
const STATUS_PATH = join(META_DIR, "strategy-status.json");
const LOG_PATH = join(META_DIR, "strategy-review.log");

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseDuration(raw, fallbackMs) {
  if (!raw) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(amount * mult[unit]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(line) {
  writeFileSync(LOG_PATH, `${line}\n`, { flag: "a" });
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function loadManifest() {
  return readJson(join(META_DIR, "manifest.json"));
}

function workerCheckpointsFromManifest(manifest) {
  return (manifest?.experiments ?? [])
    .filter((exp) => exp.name.startsWith("worker"))
    .map((exp) => ({
      name: exp.name,
      sessionIndex: exp.sessionIndex,
      checkpointPath: exp.checkpointPath,
    }));
}

async function applyVerdict(verdict, manifest, cwd, excludeSession) {
  const actions = [];

  if (verdict.pivot) {
    for (const exp of manifest?.experiments ?? []) {
      if (!exp.sessionId || exp.sessionIndex === excludeSession) continue;
      if (exp.name.startsWith("worker")) {
        try {
          await interceptIdeChat({
            sessionId: exp.sessionId,
            prompt: `[Strategy pivot] ${verdict.pivot}`,
            cwd,
          });
          actions.push({ type: "pivot", sessionIndex: exp.sessionIndex, sessionId: exp.sessionId });
        } catch (error) {
          actions.push({
            type: "pivot_error",
            sessionIndex: exp.sessionIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  for (const sessionIndex of verdict.kill ?? []) {
    if (sessionIndex === excludeSession) continue;
    const exp = (manifest?.experiments ?? []).find((row) => row.sessionIndex === sessionIndex);
    if (!exp?.sessionId) continue;
    try {
      await interceptIdeChat({
        sessionId: exp.sessionId,
        prompt:
          "Strategy review: this branch is stale. Stop current approach. Pick a fresh, small, test-verified improvement.",
        cwd,
      });
      actions.push({ type: "kill", sessionIndex, sessionId: exp.sessionId });
    } catch (error) {
      actions.push({
        type: "kill_error",
        sessionIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return actions;
}

async function reviewOnce(params) {
  const manifest = loadManifest();
  const cwd = params.cwd;
  const workspace = basename(cwd);
  const service = params.useLlm ? new CursorLocalService({ apiKey: process.env.CURSOR_API_KEY }) : undefined;

  const result = await runStrategyReview(service, {
    goal: params.goal,
    cwd,
    successCriteria: params.successCriteria,
    workspace,
    workerCheckpoints: workerCheckpointsFromManifest(manifest),
    useLlm: params.useLlm && Boolean(process.env.CURSOR_API_KEY),
    model: params.model,
  });

  const actions =
    !result.verdict.onTrack && manifest
      ? await applyVerdict(result.verdict, manifest, cwd, params.excludeSession)
      : [];

  const snapshot = {
    at: result.reviewedAt,
    source: result.source,
    onTrack: result.verdict.onTrack,
    score: result.verdict.score,
    issues: result.verdict.issues,
    recommendation: result.verdict.recommendation,
    pivot: result.verdict.pivot,
    spawn: result.verdict.spawn,
    kill: result.verdict.kill,
    actions,
  };

  writeFileSync(STATUS_PATH, JSON.stringify(snapshot, null, 2));
  appendLog(JSON.stringify(snapshot));
  console.error(JSON.stringify(snapshot));
  return snapshot;
}

const cwd = argValue("--cwd") ?? "/Users/trevorsmith/Projects/cursor-meta-mcp";
const excludeSession = argValue("--exclude-session") ? Number(argValue("--exclude-session")) : 1;
const intervalMs = parseDuration(argValue("--interval"), 5 * 60_000);
const useLlm = flag("--use-llm");
const once = flag("--once");
const goal = argValue("--goal") ?? DEFAULT_SELF_IMPROVE_GOAL;
const successCriteria = DEFAULT_SELF_IMPROVE_CRITERIA;

appendLog(
  `[${new Date().toISOString()}] strategy-review-loop start cwd=${cwd} interval=${intervalMs} useLlm=${useLlm}`,
);

const params = { cwd, excludeSession, useLlm, goal, successCriteria, model: argValue("--model") };

if (once) {
  await reviewOnce(params);
  process.exit(0);
}

while (true) {
  try {
    await reviewOnce(params);
  } catch (error) {
    appendLog(
      `[${new Date().toISOString()}] error ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await sleep(intervalMs);
}
