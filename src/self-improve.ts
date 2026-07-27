import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { waitForChatSession } from "./chat-activity.js";
import { runConsciousnessPulse } from "./consciousness-pulse.js";
import { createIdeChat } from "./ide-chat-control.js";
import { createWorkerWorktree, type WorktreeInfo } from "./git-worktree.js";
import { getSessionIndexForId } from "./history-store.js";
import { stopFleetProcesses } from "./fleet-control.js";
import {
  formatGitSyncStatusForPrompt,
  getGitSyncStatus,
  gitFetch,
  selfImproveGitRules,
} from "./git-sync.js";
import { spawnLongSession, type LongSessionParams } from "./long-session.js";
import { envForWorkers, resolveWorkerNodeBin } from "./load-env.js";
import { formatGenomeForPrompt, ensureGenome } from "./genome.js";
import { fleetTargetWarning, formatVerifyCommandLabel, resolveVerifyCommands } from "./fleet-target.js";
import { formatCiRulesForPrompt, resolveFleetCiPolicy } from "./fleet-ci-policy.js";
import { TICK_REPORT_INSTRUCTION } from "./ground-truth.js";
import { formatLearningsForPrompt } from "./learnings.js";
import { spawnSdkWorker, resolveTickIntervalMs, type SdkWorkerParams } from "./sdk-worker.js";
import { experimentsDir, metaHome } from "./meta-home.js";
import {
  assertBudgetAllowed,
  defaultBudgetLimits,
  recordBudgetEvent,
  recordSpawn,
  resetFleetBudgetClock,
} from "./plan-budget.js";
import { acquireLock, pruneStaleLocks, releaseLock } from "./process-lock.js";
import {
  DEFAULT_SELF_IMPROVE_GOAL,
} from "./strategy-review.js";
import {
  resolveHonestWorkerMode,
  probeWorkerAuth,
  workerAuthHint,
  type WorkerAuthStatus,
} from "./worker-auth.js";
import { pushGoal, setNorthStar } from "./world-model.js";

export interface SelfImproveParams {
  cwd: string;
  /** Conductor session to exclude from orchestrator (default 1). */
  excludeSessionIndex?: number;
  /** Existing IDE tabs to attach workers to. */
  workerSessionIndexes?: number[];
  durationMs?: number;
  /** Pulse orchestrator loop (default false — honest loop uses one self-propelling worker). */
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
  /** Reset budget clock when stopping prior fleet (default true). Set false for resume. */
  freshStart?: boolean;
  /** Continue SDK workers from existing checkpoints instead of wiping them. */
  resumeWorkers?: boolean;
  /** Max wait for dedicated chat in SQLite after create (default 120s). */
  dedicatedChatWaitMs?: number;
  /** Worker backend: IDE tabs, headless SDK, or both. Default sdk for honest loop. */
  workerMode?: "ide" | "sdk" | "hybrid";
  /** Headless SDK workers in isolated git worktrees. Default 1 for honest loop. */
  parallelWorkers?: number;
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
  workerMode?: string;
  workerAuth?: WorkerAuthStatus & { note?: string };
  watcherPid?: number;
  strategyReviewerPid?: number;
}

const DEFAULT_WORKER_SESSIONS: number[] = [];
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

/** Singleton roles — only one of each may run per meta dir. */
export const FLEET_LOCK_NAMES = [
  "fleet-launch",
  "orchestrator-loop",
  "strategy-review-loop",
  "watch-experiments",
];

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
export function buildSelfImprovePrompt(cwd: string, base?: string, metaDir?: string): string {
  const lines = [base?.trim() || SELF_IMPROVE_BASE_PROMPT, ""];
  const meta = metaDir ?? metaHome();
  const genome = formatGenomeForPrompt(meta);
  if (genome) lines.push(genome);
  const lessons = formatLearningsForPrompt(meta);
  if (lessons) lines.push(lessons);
  const gitStatus = getGitSyncStatus(cwd);
  lines.push(formatGitSyncStatusForPrompt(gitStatus, cwd), "");

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

  const verify = formatVerifyCommandLabel(resolveVerifyCommands(cwd));
  const ciPolicy = resolveFleetCiPolicy(cwd);
  lines.push(
    "Rules: no user questions, no architecture theater.",
    `Verify before tick report: ${verify}`,
    formatCiRulesForPrompt(ciPolicy, verify),
    TICK_REPORT_INSTRUCTION,
    selfImproveGitRules(cwd),
  );

  const targetWarning = fleetTargetWarning(cwd);
  if (targetWarning) lines.push("", `Target warning: ${targetWarning}`);

  return lines.join("\n");
}

export interface FleetSupervisorArgsParams {
  cwd: string;
  /** Per-project experiments dir. */
  metaDir: string;
  excludeSessionIndex: number;
  strategyIntervalMs: number;
  goal: string;
  useLlm: boolean;
  watchInterval?: string;
}

/**
 * CLI args for the three supervisor loops.
 *
 * Every loop must receive `--meta-dir`; without it each one falls back to the
 * global `~/.cursor-meta/experiments` and reads a different fleet than the one
 * that spawned it.
 */
export function fleetSupervisorArgs(params: FleetSupervisorArgsParams): {
  strategyReview: string[];
  orchestrator: string[];
  watcher: string[];
} {
  const { cwd, metaDir } = params;
  const workspace = basename(cwd);
  const exclude = String(params.excludeSessionIndex);

  return {
    strategyReview: [
      "--import",
      "tsx",
      "scripts/strategy-review-loop.mjs",
      "--cwd",
      cwd,
      "--meta-dir",
      metaDir,
      "--exclude-session",
      exclude,
      "--interval",
      `${params.strategyIntervalMs}ms`,
      "--goal",
      params.goal,
      ...(params.useLlm ? ["--use-llm"] : []),
    ],
    orchestrator: [
      "--import",
      "tsx",
      "scripts/orchestrate-loop.mjs",
      "--workspace",
      workspace,
      "--meta-dir",
      metaDir,
      "--exclude-session",
      exclude,
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
    watcher: [
      "--import",
      "tsx",
      "scripts/watch-experiments.mjs",
      "--interval",
      params.watchInterval ?? "30s",
      "--meta-dir",
      metaDir,
      "--root",
      cwd,
      "--workspace",
      workspace,
    ],
  };
}

function spawnDetached(
  name: string,
  args: string[],
  logPath: string,
  cwd: string,
): { name: string; pid: number; logPath: string; command: string } {
  writeFileSync(logPath, `[${new Date().toISOString()}] starting ${name}\n`, { flag: "a" });
  const out = openSync(logPath, "a");
  const nodeBin = resolveWorkerNodeBin();
  const command = [nodeBin, ...args].join(" ");
  const child = spawn(nodeBin, args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: envForWorkers(),
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
    metaDir: metaHome(),
  };
}

export function fleetSpawnPlan(
  workerMode: "ide" | "sdk" | "hybrid",
  parallelWorkers: number,
): { spawnIde: boolean; spawnSdk: boolean } {
  return {
    spawnIde: workerMode === "ide" || workerMode === "hybrid",
    spawnSdk: (workerMode === "sdk" || workerMode === "hybrid") && parallelWorkers > 0,
  };
}

/** Injectable launcher so callers (and tests) can substitute a stub. */
export type FleetLauncher = (params: SelfImproveParams) => Promise<SelfImproveManifest>;

export async function launchSelfImproveFleet(params: SelfImproveParams): Promise<SelfImproveManifest> {
  const cwd = params.cwd.trim();
  if (!cwd) {
    throw new Error("cwd is required.");
  }

  gitFetch(cwd);

  const metaDir = params.metaDir ?? experimentsDir();
  mkdirSync(metaDir, { recursive: true });

  if (params.stopExisting ?? true) {
    stopFleetProcesses(metaDir);
    pruneStaleLocks(FLEET_LOCK_NAMES, metaDir);
    if (params.freshStart ?? true) {
      resetFleetBudgetClock();
    }
  }

  // Serialize launches. Two fleets racing each other spawn untracked duplicate loops.
  const launchLock = acquireLock("fleet-launch", metaDir);
  if (!launchLock.acquired) {
    throw new Error(
      `Fleet launch already in progress (pid ${launchLock.heldBy?.pid}). Stop it first or remove ${launchLock.path}.`,
    );
  }

  try {
    return await launchFleetProcesses(params, cwd, metaDir);
  } finally {
    releaseLock("fleet-launch", metaDir);
  }
}

async function launchFleetProcesses(
  params: SelfImproveParams,
  cwd: string,
  metaDir: string,
): Promise<SelfImproveManifest> {
  const durationMs = params.durationMs ?? DEFAULT_DURATION_MS;
  const exclude = params.excludeSessionIndex ?? 1;
  const limits = defaultBudgetLimits();
  const workerIndexes = (params.workerSessionIndexes ?? DEFAULT_WORKER_SESSIONS).slice(
    0,
    limits.maxConcurrentWorkers,
  );
  assertBudgetAllowed("spawn_fleet_worker");
  recordBudgetEvent({ at: new Date().toISOString(), action: "fleet_start", source: "meta_self_improve" });
  const prompt = buildSelfImprovePrompt(cwd, params.prompt ?? params.goal, metaDir);
  const auth = await probeWorkerAuth();
  const workerMode = await resolveHonestWorkerMode(params.workerMode);
  const authNote = workerAuthHint(auth);
  writeFileSync(join(metaDir, "worker-auth.json"), JSON.stringify({ at: new Date().toISOString(), ...auth, note: authNote }, null, 2));
  if (workerMode !== (params.workerMode ?? "sdk")) {
    writeFileSync(join(metaDir, "fleet-launch.log"), `[${new Date().toISOString()}] ${authNote}\n`, { flag: "a" });
  }
  const parallelWorkers = Math.min(
    params.parallelWorkers ?? 1,
    limits.maxConcurrentWorkers,
  );
  const { spawnIde, spawnSdk } = fleetSpawnPlan(workerMode, parallelWorkers);

  console.error(`[fleet] workerMode=${workerMode} auth=${JSON.stringify(auth)} — ${authNote}`);

  let sessionId = "";
  let dedicatedIndex: number | null = null;

  if (spawnIde) {
    ({ sessionId } = await createIdeChat());
    const dedicatedWaitMs = params.dedicatedChatWaitMs ?? 120_000;
    try {
      await waitForChatSession(sessionId, { timeoutMs: dedicatedWaitMs, pollMs: 1000 });
    } catch {
      // Fresh IDE chats often lag in SQLite; long-session soft-skips until they appear.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    dedicatedIndex = getSessionIndexForId(sessionId) ?? null;
    if (dedicatedIndex == null) {
      try {
        await waitForChatSession(sessionId, { timeoutMs: 30_000, pollMs: 1000 });
        dedicatedIndex = getSessionIndexForId(sessionId) ?? null;
      } catch {
        /* still proceed with sessionId only */
      }
    }

    writeFileSync(
      join(metaDir, "dedicated-worker.json"),
      JSON.stringify({ sessionId, sessionIndex: dedicatedIndex, createdAt: new Date().toISOString() }, null, 2),
    );
  }

  const experiments: SelfImproveExperiment[] = [];
  const goal = params.goal?.trim() || DEFAULT_SELF_IMPROVE_GOAL;
  const manifestPath = join(metaDir, "manifest.json");
  const manifest: SelfImproveManifest = {
    at: new Date().toISOString(),
    root: cwd,
    goal,
    conductorExcluded: [exclude],
    dedicatedWorker: { sessionId: sessionId || "headless", sessionIndex: dedicatedIndex },
    experiments,
    manifestPath,
    workerMode,
    workerAuth: { ...auth, note: authNote },
  };

  // Persist after every spawn: a launch that dies midway must still leave a manifest
  // that lists the pids it already created, or they become unkillable orphans.
  const persistManifest = () => {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  };
  persistManifest();

  const worktrees: WorktreeInfo[] = [];

  if (spawnSdk && parallelWorkers > 0 && !auth.apiKey) {
    throw new Error(
      "SDK fleet requires CURSOR_API_KEY in ~/.cursor/.env. CLI fallback fails in detached workers (ENOENT / shell). Create a key at https://cursor.com/dashboard/integrations?tab=api-keys",
    );
  }

  if (spawnSdk && parallelWorkers > 0) {
    for (let i = 0; i < parallelWorkers; i += 1) {
      const name = `sdk-worker-${i + 1}`;
      let workerCwd = cwd;
      try {
        const wt = createWorkerWorktree(cwd, name, i + 1);
        worktrees.push(wt);
        workerCwd = wt.path;
        writeFileSync(
          join(metaDir, `${name}.worktree.json`),
          JSON.stringify(wt, null, 2),
        );
      } catch {
        /* fall back to shared cwd if worktree creation fails */
      }

      const checkpointPath = join(metaDir, `${name}.json`);
      const sdkCfg: SdkWorkerParams = {
        cwd: workerCwd,
        durationMs,
        tickIntervalMs: resolveTickIntervalMs(),
        maxTicks: 500,
        checkpointPath,
        prompt,
        metaDir: metaHome(),
        resume: params.resumeWorkers ?? false,
      };
      const spawned = spawnSdkWorker(sdkCfg);
      recordSpawn("spawn_fleet_worker", name);
      experiments.push({
        name,
        pid: spawned.pid,
        checkpointPath: spawned.checkpointPath,
        logPath: spawned.logPath,
        command: spawned.command.join(" "),
      });
      persistManifest();
    }
  } else if (spawnSdk) {
    const name = "sdk-worker-main";
    const checkpointPath = join(metaDir, `${name}.json`);
    const spawned = spawnSdkWorker({
      cwd,
      durationMs,
      tickIntervalMs: resolveTickIntervalMs(),
      maxTicks: 500,
      checkpointPath,
      prompt,
      metaDir: metaHome(),
      resume: params.resumeWorkers ?? false,
    });
    recordSpawn("spawn_fleet_worker", name);
    experiments.push({
      name,
      pid: spawned.pid,
      checkpointPath: spawned.checkpointPath,
      logPath: spawned.logPath,
      command: spawned.command.join(" "),
    });
    persistManifest();
  }

  if (spawnIde) {
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
      persistManifest();
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
    persistManifest();
  }

  try {
    const worldMeta = metaHome();
    ensureGenome(worldMeta);
    setNorthStar("Build persistent autonomous intelligence", worldMeta);
    pushGoal(goal, worldMeta);
  } catch {
    /* world model is best-effort */
  }
  let strategyReviewerPid: number | undefined;

  const supervisorArgs = fleetSupervisorArgs({
    cwd,
    metaDir,
    excludeSessionIndex: exclude,
    strategyIntervalMs: params.strategyReviewIntervalMs ?? 5 * 60_000,
    goal,
    useLlm: Boolean(process.env.CURSOR_API_KEY),
  });

  if (params.withStrategyReviewer ?? true) {
    const logPath = join(metaDir, "strategy-review.log");
    const strategyReviewer = spawnDetached(
      "strategy-review-loop",
      supervisorArgs.strategyReview,
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
    manifest.strategyReviewerPid = strategyReviewerPid;
    persistManifest();
  }

  if (params.withOrchestrator ?? false) {
    const logPath = join(metaDir, "orchestrator.log");
    const orchestrator = spawnDetached(
      "orchestrator-loop",
      supervisorArgs.orchestrator,
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
    persistManifest();
  }

  if (params.withWatcher ?? true) {
    const watchLog = join(metaDir, "watch.log");
    writeFileSync(watchLog, `[${new Date().toISOString()}] spawning watch-experiments\n`, { flag: "a" });
    const watchOut = openSync(watchLog, "a");
    const nodeBin = resolveWorkerNodeBin();
    const watcher = spawn(nodeBin, supervisorArgs.watcher, {
      cwd: packageRoot(),
      detached: true,
      stdio: ["ignore", watchOut, watchOut],
      env: envForWorkers(),
    });
    watcher.unref();
    manifest.watcherPid = watcher.pid ?? undefined;
    persistManifest();
  }

  return manifest;
}
