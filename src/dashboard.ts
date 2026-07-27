import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  countActiveWorkers,
  evaluateFleetSupervisor,
  loadFleetManifest,
  type FleetExperiment,
} from "./budget-supervisor.js";
import { runConsciousnessPulse } from "./consciousness-pulse.js";
import { readDedicatedWorker } from "./fleet-control.js";
import {
  friendlyExperimentName,
  friendlySdkAgentLabel,
  indexWorkerAgents,
} from "./fleet-labels.js";
import {
  analyzeWorkerCheckpoint,
  attemptedTickCount,
  meetsProductiveTickGate,
  PRODUCTIVE_TICK_GATE,
  type FleetTickMetrics,
} from "./fleet-metrics.js";
import { formatGitSyncStatusForPrompt, getGitSyncStatus, type GitSyncStatus } from "./git-sync.js";
import { getBudgetSnapshot, loadBudgetState } from "./plan-budget.js";
import { readCheckpoint, summarizeLongSession, coerceStopReason, type LongSessionState } from "./long-session.js";
import { recentRunThoughts, type RunEventRecord } from "./run-events.js";
import { formatWorldModelForPrompt, listSkills, loadWorldModel, recentEpisodes, type WorldModel } from "./world-model.js";

export interface DashboardLogSource {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface DashboardExperimentRow {
  name: string;
  displayName: string;
  pid: number;
  alive: boolean;
  sessionId?: string;
  sessionIndex?: number;
  checkpointPath?: string;
  logPath?: string;
  relaunchCount?: number;
  agentId?: string;
  checkpoint?: {
    exists: boolean;
    ticks?: number;
    productiveTicks?: number;
    productiveRatio?: number;
    attemptedTicks?: number;
    stoppedBecause?: string | null;
    lastTick?: LongSessionState["ticks"][number] | null;
    summary?: ReturnType<typeof summarizeLongSession>;
    metrics?: FleetTickMetrics | null;
  };
}

export interface FleetProductivitySummary {
  workerCount: number;
  totalTicks: number;
  attemptedTicks: number;
  productiveTicks: number;
  productiveRatio: number;
  meetsGate: boolean;
  gatePercent: number;
}

export interface SpawnThought {
  id: string;
  source: "worker" | "chat" | "sdk-run";
  label: string;
  status: "active" | "idle" | "error" | "dead";
  kind: "thinking" | "assistant" | "tool" | "status" | "error" | "other";
  text: string;
  at?: string;
  sessionIndex?: number;
  runId?: string;
}

export interface ActiveSummaryLine {
  level: "info" | "ok" | "warn" | "bad";
  text: string;
}

export interface ActiveSummary {
  at: string;
  headline: string;
  lines: ActiveSummaryLine[];
}

export interface DashboardLiveSnapshot {
  at: string;
  activeSummary: ActiveSummary;
  spawnThoughts: SpawnThought[];
  fleetHealth: DashboardSnapshot["fleetHealth"];
  pulseAt?: string;
  liveChatCount: number;
  worldModel?: {
    northStar?: string;
    activeGoalCount: number;
    recentEpisodeCount: number;
    summary: string;
  };
}

export interface DashboardSnapshot {
  at: string;
  metaDir: string;
  manifest: ReturnType<typeof loadFleetManifest>;
  fleetHealth: {
    total: number;
    alive: number;
    watcherAlive: boolean;
    strategyReviewerAlive: boolean;
    manifestAt: string | null;
    staleManifest: boolean;
  };
  supervisor: ReturnType<typeof evaluateFleetSupervisor>;
  budget: ReturnType<typeof getBudgetSnapshot>;
  watchStatus: Record<string, unknown> | null;
  strategyStatus: Record<string, unknown> | null;
  pulse: ReturnType<typeof runConsciousnessPulse> | { error: string };
  experiments: DashboardExperimentRow[];
  logs: DashboardLogSource[];
  dedicatedWorker: { sessionId?: string; sessionIndex?: number | null } | null;
  gitSync: GitSyncStatus & { summary: string };
  fleetRuntime: {
    elapsedMs: number;
    maxDurationMs: number;
    percent: number;
    remainingMs: number;
  } | null;
  fleetProductivity: FleetProductivitySummary | null;
}

export function defaultMetaDir(): string {
  return join(homedir(), ".cursor-meta");
}

export function defaultExperimentsDir(metaDir = defaultMetaDir()): string {
  return join(metaDir, "experiments");
}

export function readJsonSafe<T = Record<string, unknown>>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tailFile(path: string, maxLines = 80): string {
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

export function listLogSources(experimentsDir: string): DashboardLogSource[] {
  if (!existsSync(experimentsDir)) return [];
  const entries: DashboardLogSource[] = [];
  for (const name of readdirSync(experimentsDir)) {
    if (!name.endsWith(".log")) continue;
    const path = join(experimentsDir, name);
    try {
      const stat = statSync(path);
      entries.push({
        name: basename(name, ".log"),
        path,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      /* skip */
    }
  }
  return entries.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

function summarizeCheckpoint(path?: string): DashboardExperimentRow["checkpoint"] {
  if (!path || !existsSync(path)) return { exists: false };
  const metrics = analyzeWorkerCheckpoint(path);
  try {
    const state = readCheckpoint(path);
    const lastTick = state.ticks.at(-1) ?? null;
    return {
      exists: true,
      ticks: metrics?.ticks ?? state.ticks.length,
      productiveTicks: metrics?.productiveTicks,
      productiveRatio: metrics?.productiveRatio,
      attemptedTicks: metrics?.attemptedTicks,
      stoppedBecause: metrics?.stoppedBecause ?? state.stoppedBecause ?? null,
      lastTick,
      metrics,
      summary: summarizeLongSession({
        ...state,
        endedAt: lastTick?.at ?? state.startedAt,
        elapsedMs: 0,
        checkpointPath: path,
        stoppedBecause: coerceStopReason(metrics?.stoppedBecause ?? state.stoppedBecause),
      }),
    };
  } catch {
    if (!metrics) return { exists: true, ticks: 0, stoppedBecause: null, lastTick: null };
    return {
      exists: true,
      ticks: metrics.ticks,
      productiveTicks: metrics.productiveTicks,
      productiveRatio: metrics.productiveRatio,
      attemptedTicks: metrics.attemptedTicks,
      stoppedBecause: metrics.stoppedBecause ?? null,
      lastTick: null,
      metrics,
    };
  }
}

export function summarizeFleetProductivity(experiments: DashboardExperimentRow[]): FleetProductivitySummary | null {
  const workers = experiments.filter(
    (row) => row.name.startsWith("worker") || row.name.startsWith("sdk-worker"),
  );
  if (workers.length === 0) return null;
  let totalTicks = 0;
  let productiveTicks = 0;
  let softSkips = 0;
  for (const worker of workers) {
    const metrics = worker.checkpoint?.metrics ?? analyzeWorkerCheckpoint(worker.checkpointPath);
    if (!metrics) continue;
    totalTicks += metrics.ticks;
    productiveTicks += metrics.productiveTicks;
    softSkips += metrics.softSkips;
  }
  const attempted = Math.max(0, totalTicks - softSkips);
  const productiveRatio = attempted > 0 ? productiveTicks / attempted : 0;
  return {
    workerCount: workers.length,
    totalTicks,
    attemptedTicks: attempted,
    productiveTicks,
    productiveRatio,
    meetsGate: meetsProductiveTickGate({
      ticks: totalTicks,
      attemptedTicks: attempted,
      productiveTicks,
      productiveRatio,
      commits: 0,
      filesChanged: 0,
      errors: 0,
      softSkips,
      testFailures: 0,
      lastCommitted: false,
      lastPushed: false,
    }),
    gatePercent: PRODUCTIVE_TICK_GATE * 100,
  };
}

export function buildExperimentRows(
  experiments: FleetExperiment[],
  watchStatus: Record<string, unknown> | null,
): DashboardExperimentRow[] {
  const watchByName = new Map<string, Record<string, unknown>>();
  const watchExperiments = Array.isArray(watchStatus?.experiments)
    ? (watchStatus!.experiments as Record<string, unknown>[])
    : [];
  for (const row of watchExperiments) {
    if (typeof row.name === "string") watchByName.set(row.name, row);
  }

  return experiments.map((exp) => {
    const watch = watchByName.get(exp.name);
    const alive = pidAlive(exp.pid);
    const checkpointFromWatch =
      watch?.checkpoint && typeof watch.checkpoint === "object"
        ? (watch.checkpoint as DashboardExperimentRow["checkpoint"])
        : undefined;
    const rawCheckpoint = readJsonSafe<{ agentId?: string }>(exp.checkpointPath);

    return {
      name: exp.name,
      displayName: friendlyExperimentName(exp.name),
      pid: exp.pid,
      alive,
      sessionId: exp.sessionId,
      sessionIndex: exp.sessionIndex,
      checkpointPath: exp.checkpointPath,
      logPath: exp.logPath,
      relaunchCount: exp.relaunchCount,
      agentId: rawCheckpoint?.agentId,
      checkpoint: checkpointFromWatch ?? summarizeCheckpoint(exp.checkpointPath),
    };
  });
}

let pulseCache: {
  key: string;
  at: number;
  pulse: DashboardSnapshot["pulse"];
} | null = null;

const PULSE_CACHE_MS = 3_000;

function cachedPulse(options?: { metaDir?: string; workspace?: string; pulseLimit?: number }): DashboardSnapshot["pulse"] {
  const key = `${options?.workspace ?? ""}:${options?.pulseLimit ?? 25}`;
  const now = Date.now();
  if (pulseCache && pulseCache.key === key && now - pulseCache.at < PULSE_CACHE_MS) {
    return pulseCache.pulse;
  }
  try {
    const pulse = runConsciousnessPulse({
      limit: options?.pulseLimit ?? 25,
      workspace: options?.workspace,
    });
    pulseCache = { key, at: now, pulse };
    return pulse;
  } catch (error) {
    const pulse = { error: error instanceof Error ? error.message : String(error) };
    pulseCache = { key, at: now, pulse };
    return pulse;
  }
}

function thoughtKindFromEvent(type: RunEventRecord["type"]): SpawnThought["kind"] {
  if (type === "thinking") return "thinking";
  if (type === "assistant") return "assistant";
  if (type === "tool_call") return "tool";
  if (type === "status") return "status";
  return "other";
}

function thoughtKindFromTail(text: string, signals: string[] = []): SpawnThought["kind"] {
  if (signals.some((signal) => signal.includes("generating") || signal.includes("tool"))) return "tool";
  if (/\b(thinking|reasoning|planning)\b/i.test(text)) return "thinking";
  return "assistant";
}

export function buildActiveSummary(input: {
  fleetHealth: DashboardSnapshot["fleetHealth"];
  manifest: DashboardSnapshot["manifest"];
  budget: DashboardSnapshot["budget"];
  strategyStatus: DashboardSnapshot["strategyStatus"];
  pulse: DashboardSnapshot["pulse"];
  experiments: DashboardExperimentRow[];
  spawnThoughts: SpawnThought[];
  worldModel?: WorldModel;
  recentEpisodes?: ReturnType<typeof recentEpisodes>;
}): ActiveSummary {
  const lines: ActiveSummaryLine[] = [];
  const fh = input.fleetHealth;
  const goal = input.manifest?.goal?.trim();

  if (input.worldModel?.northStar) {
    const star = input.worldModel.northStar;
    lines.push({
      level: "info",
      text: `North star: ${star.slice(0, 120)}${star.length > 120 ? "…" : ""}`,
    });
  }

  if (goal) lines.push({ level: "info", text: `Goal: ${goal.slice(0, 140)}${goal.length > 140 ? "…" : ""}` });

  if (!fh.total) {
    lines.push({ level: "warn", text: "No fleet running — launch experiments to start workers." });
  } else if (fh.alive === 0) {
    lines.push({ level: "bad", text: `Fleet stopped — 0 / ${fh.total} processes alive.` });
  } else if (fh.alive < fh.total) {
    lines.push({ level: "warn", text: `Fleet degraded — ${fh.alive} / ${fh.total} processes alive.` });
  } else {
    lines.push({ level: "ok", text: `Fleet healthy — ${fh.alive} / ${fh.total} workers running.` });
  }

  const watcher = fh.watcherAlive ? "watcher on" : "watcher off";
  const strategy = fh.strategyReviewerAlive ? "strategy on" : "strategy off";
  lines.push({ level: fh.watcherAlive && fh.strategyReviewerAlive ? "ok" : "warn", text: `${watcher}, ${strategy}.` });

  const blocked = input.manifest?.budgetBlocked;
  if (blocked) {
    lines.push({
      level: "bad",
      text: `Budget blocked: ${input.manifest?.budgetBlockedReason ?? "supervisor halt"}.`,
    });
  }

  const warnings = input.budget?.warnings ?? [];
  for (const warning of warnings.slice(0, 2)) {
    lines.push({ level: "warn", text: warning });
  }

  const productivity = summarizeFleetProductivity(input.experiments);
  if (productivity && productivity.totalTicks > 0) {
    const pct = (productivity.productiveRatio * 100).toFixed(0);
    const level = productivity.meetsGate
      ? "ok"
      : productivity.attemptedTicks >= 3
        ? "warn"
        : "info";
    lines.push({
      level,
      text: `Productive ticks: ${productivity.productiveTicks}/${productivity.attemptedTicks} attempted (${pct}%, gate ${productivity.gatePercent}%).`,
    });
  }

  const strat = input.strategyStatus;
  if (strat && typeof strat.recommendation === "string" && strat.recommendation.trim()) {
    const onTrack = strat.onTrack === true;
    lines.push({
      level: onTrack ? "ok" : "warn",
      text: `Strategy: ${strat.recommendation.slice(0, 160)}${strat.recommendation.length > 160 ? "…" : ""}`,
    });
  }

  const pulse = "error" in input.pulse ? null : input.pulse;
  if (pulse) {
    if (pulse.live.length) {
      lines.push({ level: "info", text: `${pulse.live.length} live IDE chat${pulse.live.length === 1 ? "" : "s"} in flight.` });
    }
    if (pulse.frustrationEvents.length) {
      const hot = pulse.frustrationEvents[0];
      lines.push({
        level: "warn",
        text: `Frustration on #${hot.sessionIndex ?? "?"} ${hot.title}: ${hot.frustrationRisk.reason ?? "elevated risk"}.`,
      });
    }
  }

  for (const exp of input.experiments.filter((row) => row.alive).slice(0, 4)) {
    const label = exp.displayName ?? friendlyExperimentName(exp.name);
    const last = exp.checkpoint?.lastTick;
    const tail = last?.lastAssistantTail?.trim();
    const err = last?.error?.trim();
    const metrics = exp.checkpoint?.metrics;
    const ticks = exp.checkpoint?.ticks ?? metrics?.ticks ?? 0;
    if (metrics && attemptedTickCount(metrics) >= 3 && !meetsProductiveTickGate(metrics)) {
      const attempted = attemptedTickCount(metrics);
      lines.push({
        level: "warn",
        text: `${label}: productive ${(metrics.productiveRatio * 100).toFixed(0)}% below ${PRODUCTIVE_TICK_GATE * 100}% gate (${metrics.productiveTicks}/${attempted} attempted).`,
      });
    }
    if (err) {
      lines.push({ level: "bad", text: `${label}: ${err.slice(0, 120)}${err.length > 120 ? "…" : ""}` });
    } else if (last?.skipped === "busy") {
      lines.push({ level: "info", text: `${label}: waiting for chat to finish generating.` });
    } else if (tail) {
      lines.push({ level: "info", text: `${label}: ${tail.slice(0, 120)}${tail.length > 120 ? "…" : ""}` });
    } else if (ticks > 0) {
      lines.push({ level: "ok", text: `${label}: tick ${ticks} complete, idle.` });
    }
  }

  const activeThoughts = input.spawnThoughts.filter((thought) => thought.status === "active").slice(0, 3);
  for (const thought of activeThoughts) {
    lines.push({
      level: thought.kind === "error" ? "bad" : "info",
      text: `${thought.label}: ${thought.text.slice(0, 120)}${thought.text.length > 120 ? "…" : ""}`,
    });
  }

  const episodes = input.recentEpisodes ?? [];
  for (const ep of episodes.slice(0, 2)) {
    const text = [ep.actor, ep.action, ep.outcome].filter(Boolean).join(" · ");
    if (text) {
      lines.push({
        level: ep.outcome === "failure" ? "bad" : ep.outcome === "partial" ? "warn" : "ok",
        text: `Episode: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`,
      });
    }
  }

  let headline = "Standing by";
  if (blocked) headline = "Fleet blocked by budget";
  else if (!fh.total) headline = "Fleet idle";
  else if (fh.alive === 0) headline = "Fleet stopped";
  else if (fh.alive < fh.total) headline = "Fleet degraded";
  else if (activeThoughts.length) headline = `${activeThoughts.length} active spawn${activeThoughts.length === 1 ? "" : "s"}`;
  else if (pulse?.live.length) headline = `${pulse.live.length} live chat${pulse.live.length === 1 ? "" : "s"}`;
  else headline = "Fleet running smoothly";

  return { at: new Date().toISOString(), headline, lines: lines.slice(0, 12) };
}

export function collectSpawnThoughts(input: {
  metaDir?: string;
  experiments: DashboardExperimentRow[];
  pulse: DashboardSnapshot["pulse"];
}): SpawnThought[] {
  const thoughts: SpawnThought[] = [];
  const metaDir = input.metaDir ?? defaultMetaDir();
  const agentIndex = indexWorkerAgents(input.experiments);

  for (const exp of input.experiments) {
    const workerLabel = exp.displayName ?? friendlyExperimentName(exp.name);
    const last = exp.checkpoint?.lastTick;
    const tail = last?.lastAssistantTail?.trim();
    const err = last?.error?.trim();
    const status: SpawnThought["status"] = !exp.alive
      ? "dead"
      : err
        ? "error"
        : last?.skipped === "busy"
          ? "active"
          : "idle";

    if (err) {
      thoughts.push({
        id: `worker:${exp.name}:error`,
        source: "worker",
        label: workerLabel,
        status,
        kind: "error",
        text: err,
        at: last?.at,
        sessionIndex: exp.sessionIndex,
      });
    } else if (tail) {
      thoughts.push({
        id: `worker:${exp.name}:tail`,
        source: "worker",
        label: workerLabel,
        status,
        kind: thoughtKindFromTail(tail),
        text: tail,
        at: last?.at,
        sessionIndex: exp.sessionIndex,
      });
    } else if (exp.alive) {
      thoughts.push({
        id: `worker:${exp.name}:idle`,
        source: "worker",
        label: workerLabel,
        status,
        kind: last?.skipped === "busy" ? "status" : "other",
        text: last?.skipped === "busy" ? "Waiting for IDE chat to finish…" : "Worker alive, awaiting next tick.",
        at: last?.at,
        sessionIndex: exp.sessionIndex,
      });
    }
  }

  const pulse = "error" in input.pulse ? null : input.pulse;
  for (const chat of pulse?.live ?? []) {
    const text = chat.lastBubble?.trim() || chat.signals.join(", ") || "Generating…";
    thoughts.push({
      id: `chat:${chat.sessionId}`,
      source: "chat",
      label: `#${chat.sessionIndex ?? "?"} ${chat.title}`,
      status: "active",
      kind: thoughtKindFromTail(text, chat.signals),
      text,
      sessionIndex: chat.sessionIndex,
    });
  }

  const runsByAgent = new Map<string, (ReturnType<typeof recentRunThoughts>[number])>();
  for (const run of recentRunThoughts(metaDir)) {
    const key = run.agentId ?? run.runId;
    const existing = runsByAgent.get(key);
    if (!existing || Date.parse(run.modifiedAt) > Date.parse(existing.modifiedAt)) {
      runsByAgent.set(key, run);
    }
  }

  for (const run of runsByAgent.values()) {
    const latest = run.events.at(-1);
    if (!latest) continue;
    const ageMs = latest.at ? Date.now() - Date.parse(latest.at) : Number.POSITIVE_INFINITY;
    const ctx = run.agentId ? agentIndex.get(run.agentId) : undefined;
    thoughts.push({
      id: `sdk:${run.agentId ?? run.runId}`,
      source: "sdk-run",
      label: friendlySdkAgentLabel({
        agentName: run.label ?? ctx?.agentName,
        workerExperiment: ctx?.workerName,
        tick: ctx?.tick,
        agentId: run.agentId,
      }),
      status: ageMs < 120_000 ? "active" : "idle",
      kind: thoughtKindFromEvent(latest.type),
      text: latest.message,
      at: latest.at,
      runId: run.runId,
    });
  }

  return thoughts.sort((a, b) => {
    const rank = (row: SpawnThought) =>
      row.status === "active" ? 0 : row.status === "error" ? 1 : row.status === "idle" ? 2 : 3;
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    return Date.parse(b.at ?? "") - Date.parse(a.at ?? "");
  });
}

export function collectDashboardLiveSnapshot(options?: {
  metaDir?: string;
  workspace?: string;
  pulseLimit?: number;
}): DashboardLiveSnapshot {
  const metaDir = options?.metaDir ?? defaultMetaDir();
  const experimentsDir = join(metaDir, "experiments");
  const manifest = loadFleetManifest(experimentsDir);
  const state = loadBudgetState(join(metaDir, "plan-budget.json"));
  const activeWorkers = countActiveWorkers(manifest);
  const fleetStartedAt = manifest?.at ?? state.fleetStartedAt;
  const budget = getBudgetSnapshot(state, { activeWorkers, fleetStartedAt });
  const watchStatus = readJsonSafe(join(experimentsDir, "watch-status.json"));
  const strategyStatus = readJsonSafe(join(experimentsDir, "strategy-status.json"));
  const pulse = cachedPulse(options);
  const experiments = buildExperimentRows(manifest?.experiments ?? [], watchStatus);
  const aliveCount = experiments.filter((row) => row.alive).length;
  const manifestAt = manifest?.at ?? null;
  const manifestAgeMs = manifestAt ? Date.now() - Date.parse(manifestAt) : null;
  const staleManifest = aliveCount === 0 && (manifestAgeMs ?? 0) > 5 * 60_000;
  const fleetHealth = {
    total: experiments.length,
    alive: aliveCount,
    watcherAlive: pidAlive(manifest?.watcherPid),
    strategyReviewerAlive: pidAlive(manifest?.strategyReviewerPid),
    manifestAt,
    staleManifest,
  };
  const spawnThoughts = collectSpawnThoughts({ metaDir, experiments, pulse });
  const worldModel = loadWorldModel(metaDir);
  const episodes = recentEpisodes(metaDir, 8);
  const activeSummary = buildActiveSummary({
    fleetHealth,
    manifest,
    budget,
    strategyStatus,
    pulse,
    experiments,
    spawnThoughts,
    worldModel,
    recentEpisodes: episodes,
  });

  return {
    at: new Date().toISOString(),
    activeSummary,
    spawnThoughts,
    fleetHealth,
    pulseAt: "error" in pulse ? undefined : pulse.at,
    liveChatCount: "error" in pulse ? 0 : pulse.live.length,
    worldModel: {
      northStar: worldModel.northStar,
      activeGoalCount: worldModel.goals.filter((g) => g.status === "active").length,
      recentEpisodeCount: episodes.length,
      summary: formatWorldModelForPrompt(worldModel, episodes),
    },
  };
}

export function collectDashboardSnapshot(options?: {
  metaDir?: string;
  workspace?: string;
  pulseLimit?: number;
}): DashboardSnapshot {
  const metaDir = options?.metaDir ?? defaultMetaDir();
  const experimentsDir = join(metaDir, "experiments");
  const manifest = loadFleetManifest(experimentsDir);
  const state = loadBudgetState(join(metaDir, "plan-budget.json"));
  const activeWorkers = countActiveWorkers(manifest);
  const fleetStartedAt = manifest?.at ?? state.fleetStartedAt;
  const budget = getBudgetSnapshot(state, { activeWorkers, fleetStartedAt });
  const supervisor = evaluateFleetSupervisor(manifest);
  const watchStatus = readJsonSafe(join(experimentsDir, "watch-status.json"));
  const strategyStatus = readJsonSafe(join(experimentsDir, "strategy-status.json"));

  const pulse = cachedPulse(options);

  const experiments = buildExperimentRows(manifest?.experiments ?? [], watchStatus);
  const dedicatedWorker = readDedicatedWorker(experimentsDir);
  const fleetCwd = manifest?.root?.trim() || join(homedir(), "Projects", "cursor-meta-mcp");
  const gitStatus = getGitSyncStatus(fleetCwd);

  const elapsedMs = fleetStartedAt ? Date.now() - Date.parse(fleetStartedAt) : 0;
  const maxDurationMs = budget.fleet?.maxDurationMs ?? 0;
  const fleetRuntime =
    maxDurationMs > 0 && fleetStartedAt
      ? {
          elapsedMs,
          maxDurationMs,
          percent: Math.min(100, (elapsedMs / maxDurationMs) * 100),
          remainingMs: Math.max(0, maxDurationMs - elapsedMs),
        }
      : null;

  const aliveCount = experiments.filter((row) => row.alive).length;
  const manifestAt = manifest?.at ?? null;
  const manifestAgeMs = manifestAt ? Date.now() - Date.parse(manifestAt) : null;
  const staleManifest = aliveCount === 0 && (manifestAgeMs ?? 0) > 5 * 60_000;

  return {
    at: new Date().toISOString(),
    metaDir,
    manifest,
    fleetHealth: {
      total: experiments.length,
      alive: aliveCount,
      watcherAlive: pidAlive(manifest?.watcherPid),
      strategyReviewerAlive: pidAlive(manifest?.strategyReviewerPid),
      manifestAt,
      staleManifest,
    },
    supervisor,
    budget,
    watchStatus,
    strategyStatus,
    pulse,
    experiments,
    logs: listLogSources(experimentsDir),
    dedicatedWorker,
    gitSync: { ...gitStatus, summary: formatGitSyncStatusForPrompt(gitStatus) },
    fleetRuntime,
    fleetProductivity: summarizeFleetProductivity(experiments),
  };
}
