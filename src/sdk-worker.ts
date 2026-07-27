import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { envForWorkers, resolveWorkerNodeBin } from "./load-env.js";

import { archiveWorkerCheckpointIfNeeded } from "./checkpoint-archive.js";
import { CursorLocalService, type LocalAgentService } from "./cursor-local.js";
import { auditGroundTruth, type GroundTruthAudit } from "./ground-truth.js";
import { metaHome, metaPath } from "./meta-home.js";
import { recordTickLesson } from "./learnings.js";
import { recordBudgetEvent } from "./plan-budget.js";
import {
  captureRepoSnapshot,
  describeTickOutcome,
  runTests,
  summarizeTickOutcome,
  type TestOutcome,
  type TickOutcome,
} from "./tick-outcome.js";
import { appendEpisode } from "./world-model.js";
import { probeWorkerAuth, workerAuthHint } from "./worker-auth.js";

export interface SdkWorkerParams {
  cwd: string;
  /** Wall-clock budget. Default 2 hours. */
  durationMs?: number;
  tickIntervalMs?: number;
  maxTicks?: number;
  prompt?: string;
  model?: string;
  checkpointPath?: string;
  metaDir?: string;
  /** Injectable for tests. */
  service?: LocalAgentService;
  verifyTests?: (cwd: string) => TestOutcome | undefined;
  onTick?: (tick: SdkWorkerTick, state: SdkWorkerState) => void;
  /** Load an existing checkpoint and continue tick numbering. */
  resume?: boolean;
}

export interface SdkWorkerTick {
  tick: number;
  at: string;
  watchedMs: number;
  agentId?: string;
  runId?: string;
  lastAssistantTail?: string;
  error?: string;
  outcome?: TickOutcome;
  groundTruth?: GroundTruthAudit;
  lessonRecorded?: string;
}

export interface SdkWorkerState {
  startedAt: string;
  cwd: string;
  durationMs: number;
  maxTicks: number;
  prompt: string;
  ticks: SdkWorkerTick[];
  checkpointPath?: string;
  stoppedBecause?: SdkWorkerStopReason;
  agentId?: string;
}

export type SdkWorkerStopReason = "duration" | "max_ticks" | "error" | "consecutive_errors";

export interface SdkWorkerResult extends SdkWorkerState {
  endedAt: string;
  elapsedMs: number;
  stoppedBecause: SdkWorkerStopReason;
}

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_MAX_TICKS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultSdkCheckpointPath(name = "sdk-worker"): string {
  return metaPath("experiments", `${name}.json`);
}

export function writeSdkCheckpoint(state: SdkWorkerState, path?: string): string {
  const file = path ?? defaultSdkCheckpointPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

export const DEFAULT_SDK_WORKER_PROMPT = [
  "Autonomous headless worker. Do not ask the user questions.",
  "Each tick: one small verified improvement → npm run test:fast → git commit → report outcome.",
  "Minimize scope. No architecture theater.",
].join(" ");

export const SDK_FLEET_AGENT_NAME = "self-improve-fleet";

export async function runSdkWorkerTick(
  service: LocalAgentService,
  params: SdkWorkerParams & { agentId?: string },
  tick: number,
  prompt: string,
): Promise<SdkWorkerTick & { agentId?: string }> {
  const started = Date.now();
  try {
    const result = params.agentId
      ? await service.followUp({
          agentId: params.agentId,
          prompt,
          cwd: params.cwd,
          model: params.model,
          name: SDK_FLEET_AGENT_NAME,
        })
      : await service.runLocalAgent({
          prompt,
          cwd: params.cwd,
          model: params.model,
          mode: "agent",
          name: SDK_FLEET_AGENT_NAME,
        });

    return {
      tick,
      at: new Date().toISOString(),
      watchedMs: Date.now() - started,
      agentId: result.agentId,
      runId: result.runId,
      lastAssistantTail: result.result?.slice(-400),
    };
  } catch (error) {
    return {
      tick,
      at: new Date().toISOString(),
      watchedMs: Date.now() - started,
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadSdkCheckpoint(path: string): SdkWorkerState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SdkWorkerState;
  } catch {
    return null;
  }
}

export async function runSdkWorker(params: SdkWorkerParams): Promise<SdkWorkerResult> {
  if (!params.cwd.trim()) throw new Error("cwd is required.");

  const checkpointPath = params.checkpointPath ?? defaultSdkCheckpointPath();
  let state: SdkWorkerState | undefined;
  let startedAtMs = Date.now();

  if (params.resume) {
    const existing = loadSdkCheckpoint(checkpointPath);
    if (existing?.ticks?.length) {
      state = {
        ...existing,
        cwd: params.cwd.trim(),
        stoppedBecause: undefined,
      };
      if (params.durationMs != null) state.durationMs = params.durationMs;
      if (params.maxTicks != null) state.maxTicks = params.maxTicks;
      if (params.prompt?.trim()) state.prompt = params.prompt.trim();
      startedAtMs = Date.parse(state.startedAt);
      if (!Number.isFinite(startedAtMs)) startedAtMs = Date.now();
    }
  }

  if (!state) {
    state = {
      startedAt: new Date(startedAtMs).toISOString(),
      cwd: params.cwd.trim(),
      durationMs: params.durationMs ?? DEFAULT_DURATION_MS,
      maxTicks: params.maxTicks ?? DEFAULT_MAX_TICKS,
      prompt: params.prompt?.trim() || DEFAULT_SDK_WORKER_PROMPT,
      ticks: [],
    };
    archiveWorkerCheckpointIfNeeded(checkpointPath);
  }

  state.checkpointPath = checkpointPath;
  writeSdkCheckpoint(state, checkpointPath);
  const tickIntervalMs = params.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const metaDir = params.metaDir ?? metaHome();
  const workerEnv = envForWorkers();
  const auth = await probeWorkerAuth(workerEnv);
  if (!auth.sdk) {
    throw new Error(`SDK worker refused to start: ${workerAuthHint(auth)}`);
  }
  const service = params.service ?? new CursorLocalService({ apiKey: workerEnv.CURSOR_API_KEY });
  const verifyTests =
    params.verifyTests ??
    (process.env.CURSOR_META_SKIP_TICK_TESTS === "1" ? undefined : (cwd: string) => runTests({ cwd }));

  let agentId: string | undefined = state.agentId;
  let stoppedBecause: SdkWorkerStopReason = "duration";
  let consecutiveErrors = 0;
  const startTick =
    state.ticks.length > 0 ? (state.ticks.at(-1)?.tick ?? state.ticks.length) + 1 : 1;

  for (let tick = startTick; tick <= state.maxTicks; tick += 1) {
    if (Date.now() - startedAtMs >= state.durationMs) {
      stoppedBecause = "duration";
      break;
    }

    const repoBefore = captureRepoSnapshot(state.cwd);
    const entry = await runSdkWorkerTick(service, { ...params, agentId }, tick, state.prompt);
    if (entry.agentId) {
      agentId = entry.agentId;
      state.agentId = agentId;
    }

    if (!entry.error) {
      try {
        entry.outcome = summarizeTickOutcome({ cwd: state.cwd, before: repoBefore, verify: verifyTests });
        entry.groundTruth = auditGroundTruth(entry.lastAssistantTail, entry.outcome);
        entry.lessonRecorded =
          recordTickLesson({
            audit: entry.groundTruth,
            outcome: entry.outcome,
            metaDir,
          }) ?? undefined;
      } catch {
        /* best-effort */
      }
    } else {
      try {
        entry.lessonRecorded =
          recordTickLesson({ error: entry.error, metaDir }) ?? undefined;
      } catch {
        /* best-effort */
      }
    }

    if (entry.error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 8) {
        state.ticks.push(entry);
        writeSdkCheckpoint({ ...state, stoppedBecause: "consecutive_errors" }, checkpointPath);
        params.onTick?.(entry, state);
        return finalizeSdkWorker(state, startedAtMs, "consecutive_errors", checkpointPath);
      }
    } else {
      consecutiveErrors = 0;
    }

    state.ticks.push(entry);
    writeSdkCheckpoint(state, checkpointPath);
    params.onTick?.(entry, state);

    try {
      appendEpisode(
        {
          at: entry.at,
          actor: entry.agentId ?? "sdk-worker",
          observe: "headless sdk tick",
          action: entry.error ? "error" : "tick complete",
          verify: describeTickOutcome(entry.outcome),
          outcome: entry.error ? "failure" : entry.outcome?.producedWork ? "success" : "partial",
          notes: entry.error ?? entry.lastAssistantTail?.slice(0, 200),
        },
        metaDir,
      );
    } catch {
      /* best-effort */
    }

    try {
      recordBudgetEvent({
        at: entry.at,
        action: "ide_tick",
        source: entry.agentId ?? "sdk-worker",
        durationMs: entry.watchedMs,
      });
    } catch {
      /* best-effort */
    }

    if (state.ticks.length >= state.maxTicks) {
      stoppedBecause = "max_ticks";
      break;
    }

    await sleep(tickIntervalMs);
  }

  return finalizeSdkWorker(state, startedAtMs, stoppedBecause, checkpointPath);
}

function finalizeSdkWorker(
  state: SdkWorkerState,
  startedAtMs: number,
  stoppedBecause: SdkWorkerStopReason,
  checkpointPath: string,
): SdkWorkerResult {
  const result: SdkWorkerResult = {
    ...state,
    checkpointPath,
    endedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    stoppedBecause,
  };
  writeSdkCheckpoint({ ...state, stoppedBecause }, checkpointPath);
  return result;
}

export function summarizeSdkWorker(result: SdkWorkerResult): {
  ticks: number;
  errors: number;
  productiveTicks: number;
  commits: number;
  filesChanged: number;
  testFailures: number;
  checkpointPath: string;
} {
  const outcomes = result.ticks.map((t) => t.outcome).filter((o): o is TickOutcome => o != null);
  return {
    ticks: result.ticks.length,
    errors: result.ticks.filter((t) => t.error).length,
    productiveTicks: outcomes.filter((o) => o.producedWork).length,
    commits: outcomes.reduce((sum, o) => sum + o.commits, 0),
    filesChanged: outcomes.reduce((sum, o) => sum + o.filesChanged, 0),
    testFailures: outcomes.filter((o) => o.tests && !o.tests.passed).length,
    checkpointPath: result.checkpointPath ?? defaultSdkCheckpointPath(),
  };
}

export function buildSdkWorkerArgs(params: SdkWorkerParams): string[] {
  const args = ["--import", "tsx", "scripts/sdk-worker.mjs", "--cwd", params.cwd.trim()];
  if (params.durationMs != null) args.push("--duration", String(params.durationMs));
  if (params.maxTicks != null) args.push("--max-ticks", String(params.maxTicks));
  if (params.tickIntervalMs != null) args.push("--tick-interval", String(params.tickIntervalMs));
  if (params.checkpointPath) args.push("--checkpoint", params.checkpointPath);
  if (params.prompt) args.push("--prompt", params.prompt);
  if (params.model) args.push("--model", params.model);
  if (params.metaDir) args.push("--meta-dir", params.metaDir);
  if (params.resume) args.push("--resume");
  return args;
}

export interface SpawnSdkWorkerResult {
  pid: number;
  checkpointPath: string;
  logPath: string;
  command: string[];
}

export function spawnSdkWorker(params: SdkWorkerParams): SpawnSdkWorkerResult {
  const checkpointPath = params.checkpointPath ?? defaultSdkCheckpointPath();
  const logPath = checkpointPath.replace(/\.json$/i, ".log");
  mkdirSync(dirname(checkpointPath), { recursive: true });

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const command = buildSdkWorkerArgs({ ...params, checkpointPath });
  writeFileSync(logPath, `[${new Date().toISOString()}] sdk worker starting\n`, { flag: "a" });
  const out = openSync(logPath, "a");
  const nodeBin = resolveWorkerNodeBin();
  const child = spawn(nodeBin, command, {
    cwd: packageRoot,
    detached: true,
    stdio: ["ignore", out, out],
    env: envForWorkers(),
  });
  child.unref();

  return {
    pid: child.pid ?? -1,
    checkpointPath,
    logPath,
    command: [nodeBin, ...command],
  };
}
