import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { waitForChatSession } from "./chat-activity.js";
import { runConsciousnessPulse } from "./consciousness-pulse.js";
import { createIdeChat } from "./ide-chat-control.js";
import { getSessionIndexForId } from "./history-store.js";
import { stopFleetProcesses } from "./fleet-control.js";
import {
  formatGitSyncStatusForPrompt,
  getGitSyncStatus,
  gitFetch,
  SELF_IMPROVE_GIT_RULES,
} from "./git-sync.js";
import { spawnLongSession, type LongSessionParams } from "./long-session.js";
import {
  assertBudgetAllowed,
  defaultBudgetLimits,
  recordBudgetEvent,
  recordSpawn,
} from "./plan-budget.js";
import {
  DEFAULT_SELF_IMPROVE_GOAL,
} from "./strategy-review.js";
import { pushGoal, setNorthStar } from "./world-model.js";

export interface SelfImproveParams {
  cwd: string;
  /** Conductor session to exclude from orchestrator (default 1). */
  excludeSessionIndex?: number;
  /** Existing IDE tabs to attach workers to. */
  workerSessionIndexes?: number[];
  durationMs?: number;
  withOrchestrator?: boolean;
  withWatcher?: boolean;
  /** Dimension-4 strategy critic loop (default true). */
  withStrategyReviewer?: boolean;
  /** Strategy review interval when reviewer is enabled. */
  strategyReviewIntervalMs?: number;
  /** Mission goal for strategy review. */
  goal?: string;
  metaDir?: string;
  prompt?: string;
  /** Stop any prior fleet from manifest before launching (default true). */
  stopExisting?: boolean;
  /** Max wait for dedicated chat in SQLite after create (default 120s). */
  dedicatedChatWaitMs?: number;
}

export interface SelfImproveExperiment {
  name: string;
  pid: number;
  sessionId?: string;
  sessionIndex?: number;
  checkpointPath: string;
  logPath: string;
  command: string;
}

export interface SelfImproveManifest {
  at: string;
  root: string;
  goal: string;
  conductorExcluded: number[];
  dedicatedWorker: { sessionId: string; sessionIndex: number | null };
  experiments: SelfImproveExperiment[];
  manifestPath: string;
  watcherPid?: number;
  strategyReviewerPid?: number;
}

const DEFAULT_WORKER_SESSIONS: number[] = [];
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export const SELF_IMPROVE_BASE_PROMPT = [
  "Keep going. Do not stop or ask the user for moves.",
  "Self-improve this codebase autonomously: fix bugs, add tests, tighten heuristics, verify with npm test.",
  "Minimize scope per tick; ship small verified improvements.",
  "When idle, pick the highest-value next improvement and execute it.",
].join(" ");

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Enrich worker prompt with live pulse signals so workers avoid duplicate/meta work. */
export function buildSelfImprovePrompt(cwd: string, base?: string): string {
  const lines = [base?.trim() || SELF_IMPROVE_BASE_PROMPT, ""];
  const gitStatus = getGitSyncStatus(cwd);
  lines.push(formatGitSyncStatusForPrompt(gitStatus), "");

  try {
    const workspaceHint = basename(cwd.trim()) || cwd;
    const report = runConsciousnessPulse({ limit: 20, workspace: workspaceHint });
    const hot = report.frustrationEvents
      .filter((entry) => !entry.orchestrationExempt)
      .slice(0, 3);
    if (hot.length > 0) {
      lines.push("Pulse context (do not duplicate stuck work — pick a fresh improvement):");
      for (const entry of hot) {
        lines.push(
          `- #${entry.sessionIndex ?? "?"} ${entry.title}: ${entry.frustrationRisk.reason ?? "risk"} (${entry.signals.join(", ") || "idle"})`,
        );
      }
      lines.push("");
    }

    const parallel = report.parallelWorkspaces.find((row) => row.concurrentSessions >= 2);
    if (parallel) {
      lines.push(
        `Note: ${parallel.concurrentSessions} concurrent tabs in ${parallel.workspace} — stay focused, ship small verified diffs.`,
        "",
      );
    }
  } catch {
    /* pulse is best-effort */
  }

  lines.push(
    "Rules: no user questions, no architecture theater, npm test before claiming done.",
    SELF_IMPROVE_GIT_RULES,
  );

  return lines.join("\n");
}

function spawnDetached(
  name: string,
  args: string[],
  logPath: string,
  cwd: string,
): { name: string; pid: number; logPath: string; command: string } {
  writeFileSync(logPath, `[${new Date().toISOString()}] starting ${name}\n`, { flag: "a" });
  const out = openSync(logPath, "a");
  const command = [process.execPath, ...args].join(" ");
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return { name, pid: child.pid ?? -1, logPath, command };
}

function longSessionParams(
  name: string,
  cwd: string,
  metaDir: string,
  prompt: string,
  durationMs: number,
  target: { sessionIndex?: number; sessionId?: string },
): LongSessionParams & { name: string } {
  const slug =
    target.sessionId?.slice(0, 8) ??
    (target.sessionIndex != null ? `session-${target.sessionIndex}` : name);
  const checkpointPath = join(metaDir, `${slug}.json`);
  return {
    name,
    cwd,
    ...target,
    durationMs,
    tickIntervalMs: 60_000,
    waitTimeoutMs: 20 * 60_000,
    maxTicks: 500,
    checkpointPath,
    prompt,
  };
}

export async function launchSelfImproveFleet(params: SelfImproveParams): Promise<SelfImproveManifest> {
  const cwd = params.cwd.trim();
  if (!cwd) {
    throw new Error("cwd is required.");
  }

  gitFetch(cwd);

  const metaDir = params.metaDir ?? join(homedir(), ".cursor-meta", "experiments");
  mkdirSync(metaDir, { recursive: true });

  if (params.stopExisting ?? true) {
    stopFleetProcesses(metaDir);
  }

  const durationMs = params.durationMs ?? DEFAULT_DURATION_MS;
  const exclude = params.excludeSessionIndex ?? 1;
  const limits = defaultBudgetLimits();
  const workerIndexes = (params.workerSessionIndexes ?? DEFAULT_WORKER_SESSIONS).slice(
    0,
    limits.maxConcurrentWorkers,
  );
  assertBudgetAllowed("spawn_fleet_worker");
  recordBudgetEvent({ at: new Date().toISOString(), action: "fleet_start", source: "meta_self_improve" });
  const prompt = buildSelfImprovePrompt(cwd, params.prompt);

  const { sessionId } = await createIdeChat();
  const dedicatedWaitMs = params.dedicatedChatWaitMs ?? 120_000;
  try {
    await waitForChatSession(sessionId, { timeoutMs: dedicatedWaitMs, pollMs: 1000 });
  } catch {
    // Fresh IDE chats often lag in SQLite; long-session soft-skips until they appear.
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let dedicatedIndex = getSessionIndexForId(sessionId);
  if (dedicatedIndex == null) {
    try {
      await waitForChatSession(sessionId, { timeoutMs: 30_000, pollMs: 1000 });
      dedicatedIndex = getSessionIndexForId(sessionId);
    } catch {
      /* still proceed with sessionId only */
    }
  }

  writeFileSync(
    join(metaDir, "dedicated-worker.json"),
    JSON.stringify({ sessionId, sessionIndex: dedicatedIndex, createdAt: new Date().toISOString() }, null, 2),
  );

  const experiments: SelfImproveExperiment[] = [];

  for (const sessionIndex of workerIndexes) {
    if (sessionIndex === exclude) continue;
    const cfg = longSessionParams(
      `worker-session-${sessionIndex}`,
      cwd,
      metaDir,
      prompt,
      durationMs,
      { sessionIndex },
    );
    const spawned = spawnLongSession(cfg);
    recordSpawn("spawn_fleet_worker", cfg.name);
    experiments.push({
      name: cfg.name,
      sessionIndex,
      pid: spawned.pid,
      checkpointPath: spawned.checkpointPath,
      logPath: spawned.logPath,
      command: spawned.command.join(" "),
    });
  }

  const dedicatedCfg = longSessionParams(
    "worker-dedicated",
    cwd,
    metaDir,
    prompt,
    durationMs,
    { sessionId },
  );
  const dedicated = spawnLongSession(dedicatedCfg);
  recordSpawn("spawn_fleet_worker", dedicatedCfg.name);
  experiments.push({
    name: dedicatedCfg.name,
    sessionId,
    sessionIndex: dedicatedIndex ?? undefined,
    pid: dedicated.pid,
    checkpointPath: dedicated.checkpointPath,
    logPath: dedicated.logPath,
    command: dedicated.command.join(" "),
  });

  const goal = params.goal?.trim() || DEFAULT_SELF_IMPROVE_GOAL;
  try {
    const worldMeta = join(homedir(), ".cursor-meta");
    setNorthStar("Build persistent autonomous intelligence", worldMeta);
    pushGoal(goal, worldMeta);
  } catch {
    /* world model is best-effort */
  }
  let strategyReviewerPid: number | undefined;

  if (params.withStrategyReviewer ?? true) {
    const logPath = join(metaDir, "strategy-review.log");
    const intervalMs = params.strategyReviewIntervalMs ?? 5 * 60_000;
    const strategyReviewer = spawnDetached(
      "strategy-review-loop",
      [
        "--import",
        "tsx",
        "scripts/strategy-review-loop.mjs",
        "--cwd",
        cwd,
        "--exclude-session",
        String(exclude),
        "--interval",
        `${intervalMs}ms`,
        "--goal",
        goal,
        ...(process.env.CURSOR_API_KEY ? ["--use-llm"] : []),
      ],
      logPath,
      packageRoot(),
    );
    experiments.push({
      name: strategyReviewer.name,
      pid: strategyReviewer.pid,
      checkpointPath: join(metaDir, "strategy-status.json"),
      logPath: strategyReviewer.logPath,
      command: strategyReviewer.command,
    });
    strategyReviewerPid = strategyReviewer.pid;
  }

  if (params.withOrchestrator ?? true) {
    const logPath = join(metaDir, "orchestrator.log");
    const orchestrator = spawnDetached(
      "orchestrator-loop",
      [
        "--import",
        "tsx",
        "scripts/orchestrate-loop.mjs",
        "--workspace",
        basename(cwd),
        "--exclude-session",
        String(exclude),
        "--max-cycles",
        "120",
        "--interval-ms",
        "60000",
        "--max-actions",
        "2",
        "--keep-running",
        "--allow-continue",
        "--allow-watch",
      ],
      logPath,
      packageRoot(),
    );
    experiments.push({
      name: orchestrator.name,
      pid: orchestrator.pid,
      checkpointPath: join(metaDir, "orchestrator.json"),
      logPath: orchestrator.logPath,
      command: orchestrator.command,
    });
  }

  const manifest: SelfImproveManifest = {
    at: new Date().toISOString(),
    root: cwd,
    goal,
    conductorExcluded: [exclude],
    dedicatedWorker: { sessionId, sessionIndex: dedicatedIndex ?? null },
    experiments,
    manifestPath: join(metaDir, "manifest.json"),
    strategyReviewerPid,
  };

  writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2));

  if (params.withWatcher ?? true) {
    const watchLog = join(metaDir, "watch.log");
    writeFileSync(watchLog, `[${new Date().toISOString()}] spawning watch-experiments\n`, { flag: "a" });
    const watchOut = openSync(watchLog, "a");
    const watcher = spawn(process.execPath, ["--import", "tsx", "scripts/watch-experiments.mjs", "--interval", "30s"], {
      cwd: packageRoot(),
      detached: true,
      stdio: ["ignore", watchOut, watchOut],
      env: process.env,
    });
    watcher.unref();
    manifest.watcherPid = watcher.pid ?? undefined;
    writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2));
  }

  return manifest;
}
