import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForChatSession } from "./chat-activity.js";
import { auditGroundTruth, type GroundTruthAudit } from "./ground-truth.js";
import { metaHome, metaPath } from "./meta-home.js";
import { formatLearningsForPrompt, recordTickLesson } from "./learnings.js";
import { recordBudgetEvent } from "./plan-budget.js";
import { createIdeChat, getIdeChatActivity, sendToIdeChat } from "./ide-chat-control.js";
import { waitForChatIdle } from "./relentless-loop.js";
import {
  captureRepoSnapshot,
  describeTickOutcome,
  runTests,
  summarizeTickOutcome,
  type TestOutcome,
  type TickOutcome,
} from "./tick-outcome.js";
import { isChatActive, lastAssistantTail } from "./watch-chat.js";
import { appendEpisode } from "./world-model.js";

export interface LongSessionParams {
  cwd: string;
  sessionIndex?: number;
  sessionId?: string;
  /** Wall-clock budget. Default 10 minutes. */
  durationMs?: number;
  /** Minimum gap between ticks when the chat is already idle. */
  tickIntervalMs?: number;
  /** Hard cap on follow-up rounds. */
  maxTicks?: number;
  /** Per-generation wait before giving up on a tick. */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  idleStableMs?: number;
  prompt?: string;
  checkpointPath?: string;
  /** When true (default), skip ticks while the chat is generating instead of blocking. */
  continueOnBusy?: boolean;
  /** When true (default), keep going after idle-wait timeouts. */
  continueOnTimeout?: boolean;
  /** Stop after this many consecutive soft/hard tick errors. */
  maxConsecutiveErrors?: number;
  /** Root for world-model and budget writes. Defaults to CURSOR_META_HOME or ~/.cursor-meta. */
  metaDir?: string;
  /** Recreate the IDE chat and rebind when the bound session disappears. Default true. */
  rebindOnMissing?: boolean;
  /** Consecutive `missing` ticks tolerated before attempting a rebind. Default 3. */
  rebindAfterMissing?: number;
  /** Hook used to obtain a replacement session. Injectable for tests. */
  createSession?: () => Promise<{ sessionId: string }>;
  /** Verifier run after a tick that changed the repo. Injectable for tests. */
  verifyTests?: (cwd: string) => TestOutcome | undefined;
  /** Called after each tick for streaming progress. */
  onTick?: (tick: LongSessionTick, state: LongSessionState) => void;
}

export interface LongSessionTick {
  tick: number;
  at: string;
  watchedMs: number;
  wasAlreadyIdle: boolean;
  lastAssistantTail?: string;
  error?: string;
  skipped?: "busy" | "timeout" | "missing";
  /** Session this tick was rebound to after the previous one disappeared. */
  reboundTo?: string;
  /** Verified outcome of the work this tick produced. */
  outcome?: TickOutcome;
  /** Assistant claims vs git/test reality. */
  groundTruth?: GroundTruthAudit;
  /** Lesson appended when ground truth or tests failed. */
  lessonRecorded?: string;
}

export interface LongSessionState {
  startedAt: string;
  cwd: string;
  sessionIndex?: number;
  sessionId?: string;
  durationMs: number;
  maxTicks: number;
  prompt: string;
  ticks: LongSessionTick[];
  checkpointPath?: string;
  stoppedBecause?: LongSessionStopReason;
  /** Number of times the worker recovered from a vanished session. */
  rebinds?: number;
}

export type LongSessionStopReason = "duration" | "max_ticks" | "error" | "stopped" | "consecutive_errors";

export interface LongSessionResult extends LongSessionState {
  endedAt: string;
  elapsedMs: number;
  stoppedBecause: LongSessionStopReason;
}

export const DEFAULT_LONG_SESSION_PROMPT = [
  "Keep going. Do not stop or ask the user for moves.",
  "Self-improve this codebase autonomously: fix bugs, add tests, tighten heuristics, verify with npm test.",
  "Minimize scope per tick; ship small verified improvements.",
  "Each tick: verify with npm test, then commit and push verified work (skip .env and .tmp-*).",
  "When idle, pick the highest-value next improvement and execute it.",
].join(" ");

const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_TICK_INTERVAL_MS = 15_000;
const DEFAULT_MAX_TICKS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 45 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultCheckpointPath(sessionId?: string, sessionIndex?: number): string {
  const dir = metaPath("long-sessions");
  mkdirSync(dir, { recursive: true });
  const slug = sessionId?.slice(0, 8) ?? `session-${sessionIndex ?? "unknown"}`;
  return join(dir, `${slug}.json`);
}

export function writeCheckpoint(state: LongSessionState, path?: string): string {
  const file = path ?? defaultCheckpointPath(state.sessionId, state.sessionIndex);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

export function readCheckpoint(path: string): LongSessionState {
  return JSON.parse(readFileSync(path, "utf8")) as LongSessionState;
}

export function shouldStopLongSession(
  startedAt: number,
  tickCount: number,
  params: Pick<LongSessionParams, "durationMs" | "maxTicks">,
): LongSessionStopReason | null {
  const durationMs = params.durationMs ?? DEFAULT_DURATION_MS;
  const maxTicks = params.maxTicks ?? DEFAULT_MAX_TICKS;
  if (Date.now() - startedAt >= durationMs) return "duration";
  if (tickCount >= maxTicks) return "max_ticks";
  return null;
}

export function isTransientSessionMissing(message: string): boolean {
  return /chat session .+ not found|session #\d+ not found|not found after \d+ms/i.test(message);
}

/** Busy/missing skips do not burn the error budget; timeout soft skips do. */
export function countsTowardConsecutiveErrors(tick: LongSessionTick): boolean {
  if (!tick.error) return false;
  if (tick.skipped === "busy" || tick.skipped === "missing") return false;
  return true;
}

function safeAssistantTail(sessionIndex?: number, sessionId?: string): string | undefined {
  try {
    return lastAssistantTail(sessionIndex, sessionId);
  } catch {
    return undefined;
  }
}

export async function runLongSessionTick(
  params: LongSessionParams & { sessionId: string; sessionIndex?: number },
  tick: number,
  prompt: string,
): Promise<LongSessionTick> {
  const tickStarted = Date.now();
  let activityBefore;
  try {
    activityBefore = getIdeChatActivity({
      sessionId: params.sessionId,
      sessionIndex: params.sessionIndex,
    });
  } catch {
    activityBefore = undefined;
  }
  const continueOnBusy = params.continueOnBusy ?? true;

  if (activityBefore && isChatActive(activityBefore)) {
    if (continueOnBusy) {
      return {
        tick,
        at: new Date().toISOString(),
        watchedMs: Date.now() - tickStarted,
        wasAlreadyIdle: false,
        skipped: "busy",
        error: "chat_busy",
      };
    }
  }

  const wasAlreadyIdle = !activityBefore || !isChatActive(activityBefore);
  if (wasAlreadyIdle) {
    try {
      await sendToIdeChat({
        sessionId: params.sessionId,
        sessionIndex: params.sessionIndex,
        prompt,
        cwd: params.cwd,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientSessionMissing(message)) {
        return {
          tick,
          at: new Date().toISOString(),
          watchedMs: Date.now() - tickStarted,
          wasAlreadyIdle,
          skipped: "missing",
          error: message,
        };
      }
      throw error;
    }
  }

  try {
    await waitForChatIdle(params.sessionId, {
      pollIntervalMs: params.pollIntervalMs,
      idleStableMs: params.idleStableMs,
      timeoutMs: params.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTransientSessionMissing(message)) {
      return {
        tick,
        at: new Date().toISOString(),
        watchedMs: Date.now() - tickStarted,
        wasAlreadyIdle,
        skipped: "missing",
        error: message,
        lastAssistantTail: safeAssistantTail(params.sessionIndex, params.sessionId),
      };
    }
    const continueOnTimeout = params.continueOnTimeout ?? true;
    if (continueOnTimeout && /timed out waiting for chat/i.test(message)) {
      return {
        tick,
        at: new Date().toISOString(),
        watchedMs: Date.now() - tickStarted,
        wasAlreadyIdle,
        skipped: "timeout",
        error: message,
        lastAssistantTail: safeAssistantTail(params.sessionIndex, params.sessionId),
      };
    }
    throw error;
  }

  return {
    tick,
    at: new Date().toISOString(),
    watchedMs: Date.now() - tickStarted,
    wasAlreadyIdle,
    lastAssistantTail: safeAssistantTail(params.sessionIndex, params.sessionId),
  };
}

export async function runLongSession(params: LongSessionParams): Promise<LongSessionResult> {
  if (!params.cwd.trim()) {
    throw new Error("cwd is required.");
  }
  if (params.sessionIndex == null && !params.sessionId) {
    throw new Error("Provide sessionIndex or sessionId.");
  }

  const startedAtMs = Date.now();
  const state: LongSessionState = {
    startedAt: new Date(startedAtMs).toISOString(),
    cwd: params.cwd.trim(),
    sessionIndex: params.sessionIndex,
    sessionId: params.sessionId,
    durationMs: params.durationMs ?? DEFAULT_DURATION_MS,
    maxTicks: params.maxTicks ?? DEFAULT_MAX_TICKS,
    prompt: params.prompt?.trim() || DEFAULT_LONG_SESSION_PROMPT,
    ticks: [],
  };

  const checkpointPath = params.checkpointPath ?? defaultCheckpointPath(params.sessionId, params.sessionIndex);
  state.checkpointPath = checkpointPath;
  const tickIntervalMs = params.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const maxConsecutiveErrors = params.maxConsecutiveErrors ?? 8;
  const metaDir = params.metaDir ?? metaHome();
  const rebindOnMissing = params.rebindOnMissing ?? true;
  const rebindAfterMissing = params.rebindAfterMissing ?? 3;
  const createSession = params.createSession ?? createIdeChat;
  // Guarded so a suite that drives the tick loop can never re-invoke itself.
  const verifyTests =
    params.verifyTests ??
    (process.env.CURSOR_META_SKIP_TICK_TESTS === "1"
      ? undefined
      : (cwd: string) => runTests({ cwd }));
  let stoppedBecause: LongSessionStopReason = "duration";
  let consecutiveErrors = 0;
  let consecutiveMissing = 0;
  let resolvedSessionId = params.sessionId;

  if (resolvedSessionId) {
    try {
      await waitForChatSession(resolvedSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Freshly created chats can lag in SQLite; proceed and treat tick-level misses as soft.
      if (!isTransientSessionMissing(message)) {
        throw error;
      }
    }
  }

  for (let tick = 1; tick <= state.maxTicks; tick += 1) {
    const stop = shouldStopLongSession(startedAtMs, state.ticks.length, state);
    if (stop) {
      stoppedBecause = stop;
      break;
    }

    const tickStarted = Date.now();
    const repoBefore = captureRepoSnapshot(state.cwd);
    let entry: LongSessionTick;

    try {
      if (!resolvedSessionId && params.sessionIndex != null) {
        resolvedSessionId = getIdeChatActivity({ sessionIndex: params.sessionIndex }).sessionId;
      }
      if (!resolvedSessionId) {
        throw new Error("Could not resolve sessionId.");
      }
      state.sessionId = resolvedSessionId;

      entry = await runLongSessionTick(
        { ...params, sessionId: resolvedSessionId, sessionIndex: params.sessionIndex },
        tick,
        state.prompt,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry = {
        tick,
        at: new Date().toISOString(),
        watchedMs: Date.now() - tickStarted,
        wasAlreadyIdle: false,
        error: message,
        ...(isTransientSessionMissing(message) ? { skipped: "missing" as const } : {}),
      };
    }

    // A vanished chat is a recoverable environment fault, not a reason to end the run.
    // Sessions disappear whenever the user closes a tab, so hard-stopping here used to
    // kill workers within a tick or two of launch.
    if (entry.skipped === "missing") {
      consecutiveMissing += 1;
      if (rebindOnMissing && consecutiveMissing >= rebindAfterMissing) {
        try {
          const replacement = await createSession();
          resolvedSessionId = replacement.sessionId;
          state.sessionId = replacement.sessionId;
          state.rebinds = (state.rebinds ?? 0) + 1;
          entry.reboundTo = replacement.sessionId;
          consecutiveMissing = 0;
          try {
            await waitForChatSession(replacement.sessionId, { timeoutMs: 30_000, pollMs: 1000 });
          } catch {
            /* fresh chats lag in SQLite; next tick soft-skips until it appears */
          }
        } catch {
          /* rebind is best-effort; keep skipping until the next attempt */
        }
      }
    } else {
      consecutiveMissing = 0;
    }

    if (entry.skipped == null && !entry.error) {
      try {
        entry.outcome = summarizeTickOutcome({
          cwd: state.cwd,
          before: repoBefore,
          verify: verifyTests,
        });
        entry.groundTruth = auditGroundTruth(entry.lastAssistantTail, entry.outcome);
        entry.lessonRecorded =
          recordTickLesson({
            audit: entry.groundTruth,
            outcome: entry.outcome,
            metaDir,
          }) ?? undefined;

        if (entry.groundTruth.blocked && entry.groundTruth.correctionPrompt && resolvedSessionId) {
          try {
            await sendToIdeChat({
              sessionId: resolvedSessionId,
              sessionIndex: params.sessionIndex,
              prompt: entry.groundTruth.correctionPrompt,
              cwd: state.cwd,
            });
          } catch {
            /* correction nudge is best-effort */
          }
        }
      } catch {
        /* telemetry is best-effort */
      }
    }

    // Soft failures are ticks that intentionally skipped (busy/timeout/missing).
    // Thrown errors (e.g. continueOnTimeout=false) have no skipped marker and hard-stop.
    const softFailure = entry.skipped != null;
    if (entry.error && !softFailure) {
      state.ticks.push(entry);
      state.stoppedBecause = "error";
      writeCheckpoint({ ...state, stoppedBecause: "error" }, checkpointPath);
      params.onTick?.(entry, state);
      return finalizeLongSession(state, startedAtMs, "error", checkpointPath);
    }

    if (countsTowardConsecutiveErrors(entry)) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        state.ticks.push(entry);
        writeCheckpoint({ ...state, stoppedBecause: "consecutive_errors" }, checkpointPath);
        params.onTick?.(entry, state);
        return finalizeLongSession(state, startedAtMs, "consecutive_errors", checkpointPath);
      }
    } else {
      // Success or busy (still generating) clears the soft-error streak.
      consecutiveErrors = 0;
    }

    state.ticks.push(entry);
    writeCheckpoint(state, checkpointPath);
    params.onTick?.(entry, state);

    try {
      appendEpisode(
        {
          at: entry.at,
          actor: state.sessionId,
          observe: entry.wasAlreadyIdle ? "chat idle" : "chat active",
          action: entry.skipped ?? "tick complete",
          verify: describeTickOutcome(entry.outcome),
          outcome: episodeOutcome(entry),
          notes: entry.error ?? entry.lastAssistantTail?.slice(0, 200),
        },
        metaDir,
      );
    } catch {
      /* episode log is best-effort */
    }

    if (entry.skipped !== "busy") {
      try {
        recordBudgetEvent({
          at: entry.at,
          action: "ide_tick",
          source: state.sessionId,
          durationMs: entry.watchedMs,
        });
      } catch {
        /* budget ledger is best-effort */
      }
    }

    const stopAfterTick = shouldStopLongSession(startedAtMs, state.ticks.length, state);
    if (stopAfterTick) {
      stoppedBecause = stopAfterTick;
      break;
    }

    const elapsed = Date.now() - tickStarted;
    const waitMs = nextTickWaitMs(entry, tickIntervalMs, params.pollIntervalMs);
    if (elapsed < waitMs) {
      await sleep(waitMs - elapsed);
    }
  }

  return finalizeLongSession(state, startedAtMs, stoppedBecause, checkpointPath);
}

/**
 * Grade a tick by what it produced, not by whether the loop survived it.
 * A tick that ran cleanly but changed nothing is `partial` — otherwise the world
 * model fills with "success" rows that taught it nothing.
 */
export function episodeOutcome(tick: LongSessionTick): "success" | "failure" | "partial" {
  if (tick.error) return "failure";
  if (tick.skipped) return "partial";
  if (tick.outcome?.tests && !tick.outcome.tests.passed) return "failure";
  if (tick.outcome && !tick.outcome.producedWork) return "partial";
  return "success";
}

/** After a busy/missing skip, poll sooner so we resume promptly when the chat is ready. */
export function nextTickWaitMs(
  tick: LongSessionTick,
  tickIntervalMs: number,
  pollIntervalMs?: number,
): number {
  if (tick.skipped !== "busy" && tick.skipped !== "missing") return tickIntervalMs;
  const poll = pollIntervalMs ?? 2_000;
  return Math.min(tickIntervalMs, Math.max(poll, 2_000));
}

function finalizeLongSession(
  state: LongSessionState,
  startedAtMs: number,
  stoppedBecause: LongSessionStopReason,
  checkpointPath: string,
): LongSessionResult {
  const endedAt = new Date().toISOString();
  const result: LongSessionResult = {
    ...state,
    checkpointPath,
    endedAt,
    elapsedMs: Date.now() - startedAtMs,
    stoppedBecause,
  };
  writeCheckpoint({ ...state, checkpointPath, stoppedBecause }, checkpointPath);
  return result;
}

export function summarizeLongSession(result: LongSessionResult): {
  ticks: number;
  errors: number;
  busySkips: number;
  timeouts: number;
  missingSkips: number;
  avgWatchMs: number;
  checkpointPath: string;
  productiveTicks: number;
  commits: number;
  filesChanged: number;
  testFailures: number;
  rebinds: number;
} {
  const errors = result.ticks.filter((tick) => tick.error && tick.skipped == null).length;
  const busySkips = result.ticks.filter((tick) => tick.skipped === "busy").length;
  const timeouts = result.ticks.filter((tick) => tick.skipped === "timeout").length;
  const missingSkips = result.ticks.filter((tick) => tick.skipped === "missing").length;
  const avgWatchMs =
    result.ticks.length === 0
      ? 0
      : Math.round(result.ticks.reduce((sum, tick) => sum + tick.watchedMs, 0) / result.ticks.length);
  const outcomes = result.ticks.map((tick) => tick.outcome).filter((o): o is TickOutcome => o != null);
  return {
    ticks: result.ticks.length,
    errors,
    busySkips,
    timeouts,
    missingSkips,
    avgWatchMs,
    checkpointPath:
      result.checkpointPath ?? defaultCheckpointPath(result.sessionId, result.sessionIndex),
    productiveTicks: outcomes.filter((o) => o.producedWork).length,
    commits: outcomes.reduce((sum, o) => sum + o.commits, 0),
    filesChanged: outcomes.reduce((sum, o) => sum + o.filesChanged, 0),
    testFailures: outcomes.filter((o) => o.tests && !o.tests.passed).length,
    rebinds: result.rebinds ?? 0,
  };
}

/** Parse durations like `30m`, `2h`, `90s`, `600000ms` (unit defaults to ms). */
export function parseDurationMs(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${raw}. Use 30m, 2h, 90s, 600000ms.`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(amount * multipliers[unit]!);
}

export interface SpawnLongSessionResult {
  pid: number;
  checkpointPath: string;
  logPath: string;
  command: string[];
}

export function buildLongSessionArgs(params: LongSessionParams): string[] {
  const args = ["--import", "tsx", "scripts/long-session.mjs", "--cwd", params.cwd.trim()];
  if (params.sessionIndex != null) args.push("--session", String(params.sessionIndex));
  if (params.sessionId) args.push("--session-id", params.sessionId);
  if (params.durationMs != null) args.push("--duration", String(params.durationMs));
  if (params.maxTicks != null) args.push("--max-ticks", String(params.maxTicks));
  if (params.tickIntervalMs != null) args.push("--tick-interval", String(params.tickIntervalMs));
  if (params.waitTimeoutMs != null) args.push("--wait-timeout", String(params.waitTimeoutMs));
  if (params.pollIntervalMs != null) args.push("--poll-ms", String(params.pollIntervalMs));
  if (params.idleStableMs != null) args.push("--idle-ms", String(params.idleStableMs));
  if (params.checkpointPath) args.push("--checkpoint", params.checkpointPath);
  if (params.prompt) args.push("--prompt", params.prompt);
  if (params.continueOnBusy === false) args.push("--no-continue-on-busy");
  if (params.continueOnTimeout === false) args.push("--no-continue-on-timeout");
  if (params.maxConsecutiveErrors != null) {
    args.push("--max-consecutive-errors", String(params.maxConsecutiveErrors));
  }
  if (params.metaDir) args.push("--meta-dir", params.metaDir);
  if (params.rebindOnMissing === false) args.push("--no-rebind");
  if (params.rebindAfterMissing != null) {
    args.push("--rebind-after", String(params.rebindAfterMissing));
  }
  return args;
}

export function spawnLongSession(params: LongSessionParams): SpawnLongSessionResult {
  const checkpointPath = params.checkpointPath ?? defaultCheckpointPath(params.sessionId, params.sessionIndex);
  const logPath = checkpointPath.replace(/\.json$/i, ".log");
  mkdirSync(dirname(checkpointPath), { recursive: true });

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const command = buildLongSessionArgs({ ...params, checkpointPath });
  const out = openAppendLog(logPath);
  const child = spawn(process.execPath, command, {
    cwd: packageRoot,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();

  return {
    pid: child.pid ?? -1,
    checkpointPath,
    logPath,
    command: [process.execPath, ...command],
  };
}

function openAppendLog(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `[${new Date().toISOString()}] long session starting\n`, { flag: "a" });
  return openSync(logPath, "a");
}
