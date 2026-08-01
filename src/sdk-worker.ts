import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { envForWorkers, resolveWorkerNodeBin } from "./load-env.js";

import { archiveWorkerCheckpointIfNeeded } from "./checkpoint-archive.js";
import { CursorLocalService, type LocalAgentService } from "./cursor-local.js";
import { auditGroundTruth, TICK_REPORT_INSTRUCTION, type GroundTruthAudit } from "./ground-truth.js";
import { auditBatchCommit, auditBatchPush, formatBatchGitReminder, resolveCommitBatchPolicy } from "./fleet-commit-policy.js";
import { markTickProductivity } from "./fleet-metrics.js";
import { metaHome, metaPath } from "./meta-home.js";
import { recordTickLesson } from "./learnings.js";
import { recordSdkRunComplete } from "./plan-budget.js";
import {
  captureRepoSnapshot,
  createDefaultVerifyTests,
  describeTickOutcome,
  summarizeTickOutcome,
  type TestOutcome,
  type TickOutcome,
} from "./tick-outcome.js";
import { appendEpisode } from "./world-model.js";
import {
  downgradeFleetModel,
  fleetAgentModel,
  fleetModelRequiresCli,
  isModelRejectedError,
} from "./fleet-model.js";
import {
  describeUnreachableExports,
  findUnreachableExports,
  unwiredExports,
} from "./reachability.js";
import { probeWorkerAuth, workerAuthHint } from "./worker-auth.js";
import {
  finalizeOrbitTick,
  missionPromptBlock,
  orbitEnabled,
  prepareOrbitTick,
  workerIdFromCheckpoint,
  type OrbitTickContext,
} from "./orbit-worker.js";
import { blockMission, stationId } from "./orbit-ledger.js";
import { syncWorktreeWithBase } from "./git-worktree.js";

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
  /** Project meta root containing `orbit/`; distinct from run-event/budget meta. */
  orbitMetaDir?: string;
  /**
   * Repo the orbit station is keyed on. Workers in isolated git worktrees must
   * pass the fleet root here — their own cwd resolves to a different station
   * than the one the launch mission was filed under.
   */
  stationCwd?: string;
  /** Explicit mission mode. AGI sets true; env/ledger detection remains a fallback. */
  useOrbit?: boolean;
  /**
   * Branch the worktree should catch up to between missions, e.g.
   * `feat/thing`. Omit to leave the worktree pinned at its fork point.
   */
  baseBranch?: string;
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

export type SdkWorkerStopReason =
  | "duration"
  | "max_ticks"
  | "error"
  | "consecutive_errors"
  | "blocked_stalled"
  | "missions_drained";

export interface SdkWorkerResult extends SdkWorkerState {
  endedAt: string;
  elapsedMs: number;
  stoppedBecause: SdkWorkerStopReason;
}

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TICK_INTERVAL_MS = 60_000;

export function resolveTickIntervalMs(): number {
  const raw = process.env.CURSOR_META_TICK_INTERVAL_MS?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TICK_INTERVAL_MS;
}
const DEFAULT_MAX_TICKS = 500;

/** Blocked ticks with no repo change before a mission is parked for a human. */
export const MAX_CONSECUTIVE_BLOCKED_TICKS = 3;

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
  "Work in slices — a slice may take 20+ minutes and span many files. Stay on one slice until local verify (test+lint) is green, then commit.",
  "Minimize scope per slice; no architecture theater.",
  TICK_REPORT_INSTRUCTION,
].join("\n");

const CONTINUATION_PROMPT = [
  "Continue the current slice — work as long as needed (20+ minutes is fine).",
  "Same mission and rules as before. Run local verify when the slice is ready.",
  "Keep changes local until verify is green. Honest tick report required.",
  TICK_REPORT_INSTRUCTION,
].join("\n");

export function buildTickPrompt(
  state: SdkWorkerState,
  tick: number,
  missionBlock?: string,
): string {
  const missionPrefix = missionBlock?.trim() ? `${missionBlock.trim()}\n\n` : "";

  // Keep the mission on corrections. A blocked tick that returns only the
  // gate text tells the worker it failed without saying what it was doing —
  // fine while the SDK session holds context, useless after --resume, a model
  // downgrade, or an agentId reset.
  const prior = state.ticks.at(-1);
  if (prior?.groundTruth?.blocked && prior.groundTruth.correctionPrompt) {
    return `${missionPrefix}${prior.groundTruth.correctionPrompt}`;
  }

  if (tick <= 1) {
    const batchReminder = formatBatchGitReminder(state.ticks, resolveCommitBatchPolicy(state.cwd));
    const body = batchReminder ? `${state.prompt}\n\n${batchReminder}` : state.prompt;
    return `${missionPrefix}${body}`;
  }
  const batchReminder = formatBatchGitReminder(state.ticks, resolveCommitBatchPolicy(state.cwd));
  const lines = [CONTINUATION_PROMPT];
  if (batchReminder) lines.push(batchReminder);
  return `${missionPrefix}${lines.join("\n\n")}`;
}

/**
 * Blocks a tick that introduced exports nothing in production calls.
 *
 * Runs only on ticks that committed: an uncommitted tree has no diff range to
 * audit, and a mid-slice tick may legitimately not have wired things up yet.
 */
function auditReachability(
  cwd: string,
  sinceRef: string | undefined,
  outcome: TickOutcome | undefined,
): { violations: string[]; blocked: boolean; correctionPrompt?: string } {
  if (!sinceRef || !outcome?.committed) return { violations: [], blocked: false };

  let unwired: ReturnType<typeof unwiredExports>;
  try {
    unwired = unwiredExports(findUnreachableExports(cwd, sinceRef));
  } catch {
    return { violations: [], blocked: false };
  }

  if (unwired.length === 0) return { violations: [], blocked: false };

  const violations = describeUnreachableExports(unwired);
  return {
    violations,
    blocked: true,
    correctionPrompt: [
      "[Reachability gate] This tick added code that nothing calls:",
      ...violations.map((v) => `- ${v}`),
      "Tests exercising a module are not the same as the product using it.",
      "Either call it from the production path the mission describes, or delete it.",
    ].join("\n"),
  };
}

function mergeGroundTruthAudits(
  base: GroundTruthAudit,
  ...extras: Array<{ violations: string[]; blocked: boolean; correctionPrompt?: string }>
): GroundTruthAudit {
  const violations = [...base.violations];
  let blocked = base.blocked;
  const corrections: string[] = base.correctionPrompt ? [base.correctionPrompt] : [];
  for (const extra of extras) {
    if (extra.violations.length === 0) continue;
    violations.push(...extra.violations);
    blocked = blocked || extra.blocked;
    if (extra.correctionPrompt) corrections.push(extra.correctionPrompt);
  }
  if (violations.length === base.violations.length) return base;
  return {
    ...base,
    violations,
    blocked,
    correctionPrompt: corrections.length > 0 ? corrections.join("\n\n") : undefined,
  };
}

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
          model: fleetAgentModel(params.model),
          name: SDK_FLEET_AGENT_NAME,
        })
      : await service.runLocalAgent({
          prompt,
          cwd: params.cwd,
          model: fleetAgentModel(params.model),
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
  if (fleetModelRequiresCli() && state.agentId && state.agentId !== "cli-session") {
    state.agentId = undefined;
  }
  writeSdkCheckpoint(state, checkpointPath);
  const tickIntervalMs = params.tickIntervalMs ?? resolveTickIntervalMs();
  const metaDir = params.metaDir ?? metaHome();
  const workerEnv = envForWorkers();
  const auth = await probeWorkerAuth(workerEnv);
  if (!auth.sdk) {
    throw new Error(`SDK worker refused to start: ${workerAuthHint(auth)}`);
  }
  const service = params.service ?? new CursorLocalService({ apiKey: workerEnv.CURSOR_API_KEY });
  params.model = fleetAgentModel(params.model);
  const verifyTests =
    params.verifyTests ??
    (process.env.CURSOR_META_SKIP_TICK_TESTS === "1" ? undefined : createDefaultVerifyTests());

  let agentId: string | undefined = state.agentId;
  let stoppedBecause: SdkWorkerStopReason = "duration";
  let consecutiveErrors = 0;
  let consecutiveBlocked = 0;
  const baseBranch = params.baseBranch?.trim();
  let lastSyncedMissionId: string | undefined;
  const startTick =
    state.ticks.length > 0 ? (state.ticks.at(-1)?.tick ?? state.ticks.length) + 1 : 1;

  const orbitMetaDir = params.orbitMetaDir ?? metaDir;
  const stationCwd = params.stationCwd?.trim() || state.cwd;
  const useOrbit = params.useOrbit ?? orbitEnabled(orbitMetaDir, stationCwd);
  const orbitCtx: OrbitTickContext | null = useOrbit
    ? {
        station: stationId(stationCwd),
        workerId: workerIdFromCheckpoint(checkpointPath),
        metaDir: orbitMetaDir,
      }
    : null;

  for (let tick = startTick; tick <= state.maxTicks; tick += 1) {
    if (Date.now() - startedAtMs >= state.durationMs) {
      stoppedBecause = "duration";
      break;
    }

    let activeMission = null;
    if (orbitCtx) {
      const prep = prepareOrbitTick(orbitCtx);
      if (prep.exitDrained) {
        stoppedBecause = "missions_drained";
        break;
      }
      if (!prep.mission) {
        await sleep(tickIntervalMs);
        continue;
      }
      activeMission = prep.mission;

      // Starting a fresh mission is the one moment the tree is clean, so it is
      // the only safe point to pick up whatever peers have merged since launch.
      // Without this a worker builds its second mission against launch-time HEAD.
      if (baseBranch && activeMission.id !== lastSyncedMissionId) {
        const sync = syncWorktreeWithBase(state.cwd, baseBranch);
        lastSyncedMissionId = activeMission.id;
        // Log both outcomes. Logging only failures makes silence ambiguous
        // between "synced" and "never ran", which is unfalsifiable from the
        // outside — the same defect as a gate that reports success for work it
        // never examined.
        console.error(
          sync.synced
            ? `[sdk-worker] base sync ok (${baseBranch} -> ${activeMission.id})`
            : `[sdk-worker] base sync skipped (${sync.reason ?? "unknown"})`,
        );
      }
    }

    const repoBefore = captureRepoSnapshot(state.cwd);
    const entry = await runSdkWorkerTick(
      service,
      { ...params, agentId },
      tick,
      buildTickPrompt(state, tick, activeMission ? missionPromptBlock(activeMission) : undefined),
    );
    if (entry.agentId) {
      agentId = entry.agentId;
      state.agentId = agentId;
    }

    if (!entry.error) {
      try {
        entry.outcome = summarizeTickOutcome({ cwd: state.cwd, before: repoBefore, verify: verifyTests });
        const priorOutcomes = state.ticks
          .map((t) => t.outcome)
          .filter((o): o is TickOutcome => o != null);
        if (entry.outcome) markTickProductivity(entry.outcome, priorOutcomes);
        const batchPolicy = resolveCommitBatchPolicy(state.cwd);
        const priorWorkInSession = priorOutcomes.some((o) => o.producedWork);
        const groundTruth = auditGroundTruth(entry.lastAssistantTail, entry.outcome, {
          priorWorkInSession,
        });
        const sliceComplete =
          groundTruth.tickReport?.done === true && entry.outcome?.tests?.passed === true;
        const batchCommit = auditBatchCommit(state.ticks, entry.outcome, batchPolicy, {
          sliceComplete,
        });
        const batchPush = auditBatchPush(state.ticks, entry.outcome, batchPolicy);
        // Tests passing says the code works in isolation, not that anything
        // calls it. Without this a fully-tested module can land wired to
        // nothing and the gate reports success.
        const reachability = auditReachability(state.cwd, repoBefore.head, entry.outcome);
        entry.groundTruth = mergeGroundTruthAudits(
          groundTruth,
          batchCommit,
          batchPush,
          reachability,
        );
        // A missing footer on measured, verified work still blocks the next
        // prompt (correction) but does not zero the tick — git+tests outrank
        // footer compliance. Fabricated claims and batch-policy breaks do.
        const productivityVeto =
          groundTruth.fabrication === true || batchCommit.blocked || batchPush.blocked;
        if (productivityVeto && entry.outcome) {
          entry.outcome.countsAsProductive = false;
        }
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

    if (entry.error && isModelRejectedError(entry.error)) {
      const next = downgradeFleetModel();
      if (next) {
        console.error(
          `[sdk-worker] model rejected (${entry.error.slice(0, 120)}) — downgrading to ${next} for remaining ticks`,
        );
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

    if (orbitCtx && activeMission) {
      try {
        finalizeOrbitTick({
          ctx: orbitCtx,
          mission: activeMission,
          error: entry.error,
          outcome: entry.outcome,
          tickReportDone: entry.groundTruth?.tickReport?.done === true,
          gateBlocked: entry.groundTruth?.blocked === true,
        });
      } catch {
        /* best-effort */
      }
    }

    // Convergence guard. A tick that is blocked and produced nothing has made no
    // progress and will get the same correction next time. Nothing counted these
    // before, so a worker stuck arguing with the gate span its whole window.
    if (!entry.error && entry.groundTruth?.blocked && entry.outcome?.producedWork !== true) {
      consecutiveBlocked += 1;
    } else {
      consecutiveBlocked = 0;
    }

    if (consecutiveBlocked >= MAX_CONSECUTIVE_BLOCKED_TICKS) {
      const reason = `Blocked ${consecutiveBlocked} ticks running with no repo change: ${
        entry.groundTruth?.violations.join("; ") ?? "unknown"
      }`;
      consecutiveBlocked = 0;
      if (orbitCtx && activeMission) {
        // Park the mission for a human and move on rather than burning the
        // remaining window on one stuck unit of work.
        try {
          blockMission(orbitCtx.station, activeMission.id, reason, orbitCtx.metaDir);
          console.error(`[sdk-worker] blocked mission ${activeMission.id} — ${reason}`);
        } catch {
          /* best-effort */
        }
      } else {
        writeSdkCheckpoint({ ...state, stoppedBecause: "blocked_stalled" }, checkpointPath);
        return finalizeSdkWorker(state, startedAtMs, "blocked_stalled", checkpointPath);
      }
    }

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
      // Record as an SDK run, not an IDE tick. Logging these as `ide_tick` left
      // `sdkRuns` at zero forever, so maxSdkRunsPerHour counted a number nothing
      // incremented and could never fire.
      recordSdkRunComplete({
        durationMs: entry.watchedMs,
        model: fleetAgentModel(params.model),
        source: entry.agentId ?? "sdk-worker",
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
  args.push("--model", fleetAgentModel(params.model));
  if (params.metaDir) args.push("--meta-dir", params.metaDir);
  if (params.orbitMetaDir) args.push("--orbit-meta-dir", params.orbitMetaDir);
  if (params.stationCwd) args.push("--station-cwd", params.stationCwd.trim());
  if (params.useOrbit === true) args.push("--orbit");
  if (params.useOrbit === false) args.push("--no-orbit");
  if (params.baseBranch) args.push("--base-branch", params.baseBranch);
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
