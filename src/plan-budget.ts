import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { metaPath } from "./meta-home.js";

export type BudgetAction =
  | "spawn_sdk"
  | "spawn_fleet_worker"
  | "relaunch_worker"
  | "orchestrate_spawn"
  | "follow_up_sdk";

export type BudgetStatus = "ok" | "warn" | "blocked";

export interface BudgetLimits {
  planRequestLimit?: number;
  planUsedRequests?: number;
  monthlyBudgetCents?: number;
  maxConcurrentWorkers: number;
  maxSpawnsPerHour: number;
  maxSdkRunsPerHour: number;
  fleetBudgetPercent: number;
  estimateCentsPerSdkRun: number;
  estimateCentsPerIdeTick: number;
  maxFleetDurationMs: number;
  maxRelaunchesPerWorker: number;
  warnAtPercent: number;
  blockAtPercent: number;
}

export interface BudgetEvent {
  at: string;
  action: BudgetAction | "run_complete" | "ide_tick" | "fleet_start" | "fleet_stop" | "kill_workers";
  source?: string;
  durationMs?: number;
  model?: string;
  estimatedCents?: number;
  detail?: string;
}

export interface BudgetState {
  limits: BudgetLimits;
  planUsedRequests?: number;
  planRequestLimit?: number;
  planSource?: "env" | "manual";
  sdkRuns: number;
  sdkDurationMs: number;
  ideTicks: number;
  estimatedCents: number;
  spawnCount: number;
  relaunchCount: number;
  fleetStartedAt?: string;
  fleetStoppedAt?: string;
  budgetBlocked: boolean;
  blockedReason?: string;
  events: BudgetEvent[];
  updatedAt: string;
}

export interface BudgetSnapshot {
  at: string;
  status: BudgetStatus;
  warnings: string[];
  blockedActions: BudgetAction[];
  plan?: {
    used: number;
    limit: number;
    percent: number;
    source: string;
  };
  local: {
    estimatedCents: number;
    monthlyBudgetCents?: number;
    percent?: number;
    sdkRuns: number;
    sdkDurationMs: number;
    sdkDurationMinutes: number;
    spawnsLastHour: number;
    sdkRunsLastHour: number;
    ideTicks: number;
  };
  fleet?: {
    activeWorkers: number;
    relaunchCount: number;
    fleetElapsedMs: number;
    maxDurationMs: number;
    percentOfMaxDuration: number;
    budgetBlocked: boolean;
  };
  limits: BudgetLimits;
}

export interface BudgetGateResult {
  allowed: boolean;
  reason?: string;
  snapshot: BudgetSnapshot;
}

const MAX_EVENTS = 200;
const HOUR_MS = 60 * 60 * 1000;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseOptionalIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function defaultBudgetLimits(): BudgetLimits {
  return {
    planRequestLimit: parseOptionalIntEnv("CURSOR_META_PLAN_REQUEST_LIMIT"),
    planUsedRequests: parseOptionalIntEnv("CURSOR_META_PLAN_USED_REQUESTS"),
    monthlyBudgetCents: parseOptionalIntEnv("CURSOR_META_MONTHLY_BUDGET_CENTS"),
    maxConcurrentWorkers: parseIntEnv("CURSOR_META_MAX_CONCURRENT_WORKERS", 3),
    maxSpawnsPerHour: parseIntEnv("CURSOR_META_MAX_SPAWNS_PER_HOUR", 12),
    maxSdkRunsPerHour: parseIntEnv("CURSOR_META_MAX_SDK_RUNS_PER_HOUR", 20),
    fleetBudgetPercent: parseIntEnv("CURSOR_META_FLEET_BUDGET_PERCENT", 80),
    estimateCentsPerSdkRun: parseIntEnv("CURSOR_META_ESTIMATE_CENTS_PER_SDK_RUN", 5),
    estimateCentsPerIdeTick: parseIntEnv("CURSOR_META_ESTIMATE_CENTS_PER_IDE_TICK", 2),
    maxFleetDurationMs: parseIntEnv("CURSOR_META_MAX_FLEET_DURATION_MS", 2 * 60 * 60 * 1000),
    maxRelaunchesPerWorker: parseIntEnv("CURSOR_META_MAX_RELAUNCHES_PER_WORKER", 3),
    warnAtPercent: parseIntEnv("CURSOR_META_BUDGET_WARN_PERCENT", 70),
    blockAtPercent: parseIntEnv("CURSOR_META_BUDGET_BLOCK_PERCENT", 90),
  };
}

function defaultState(): BudgetState {
  const limits = defaultBudgetLimits();
  return {
    limits,
    planUsedRequests: limits.planUsedRequests,
    planRequestLimit: limits.planRequestLimit,
    planSource: limits.planUsedRequests != null ? "env" : undefined,
    sdkRuns: 0,
    sdkDurationMs: 0,
    ideTicks: 0,
    estimatedCents: 0,
    spawnCount: 0,
    relaunchCount: 0,
    budgetBlocked: false,
    events: [],
    updatedAt: new Date().toISOString(),
  };
}

export function budgetStatePath(): string {
  return process.env.CURSOR_META_BUDGET_PATH ?? metaPath("plan-budget.json");
}

export function loadBudgetState(path = budgetStatePath()): BudgetState {
  if (!existsSync(path)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetState>;
    const limits = { ...defaultBudgetLimits(), ...(parsed.limits ?? {}) };
    return {
      ...defaultState(),
      ...parsed,
      limits,
      planUsedRequests: parsed.planUsedRequests ?? limits.planUsedRequests,
      planRequestLimit: parsed.planRequestLimit ?? limits.planRequestLimit,
      events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : [],
    };
  } catch {
    return defaultState();
  }
}

export function saveBudgetState(state: BudgetState, path = budgetStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  state.updatedAt = new Date().toISOString();
  state.events = state.events.slice(-MAX_EVENTS);
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function pushEvent(state: BudgetState, event: BudgetEvent): void {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS);
  }
}

function eventsInLastHour(state: BudgetState, action: BudgetEvent["action"]): number {
  const cutoff = Date.now() - HOUR_MS;
  return state.events.filter((event) => {
    if (event.action !== action) return false;
    return Date.parse(event.at) >= cutoff;
  }).length;
}

const SPAWN_ACTIONS: BudgetAction[] = [
  "spawn_sdk",
  "spawn_fleet_worker",
  "relaunch_worker",
  "orchestrate_spawn",
];

function spawnsInLastHour(state: BudgetState): number {
  const cutoff = Date.now() - HOUR_MS;
  return state.events.filter((event) => {
    if (!SPAWN_ACTIONS.includes(event.action as BudgetAction)) {
      return false;
    }
    return Date.parse(event.at) >= cutoff;
  }).length;
}

function sdkRunsInLastHour(state: BudgetState): number {
  const cutoff = Date.now() - HOUR_MS;
  return state.events.filter(
    (event) => event.action === "run_complete" && Date.parse(event.at) >= cutoff,
  ).length;
}

function usagePercent(state: BudgetState): { percent: number; basis: "plan" | "budget" | "none" } {
  if (state.planRequestLimit && state.planRequestLimit > 0 && state.planUsedRequests != null) {
    return {
      percent: (state.planUsedRequests / state.planRequestLimit) * 100,
      basis: "plan",
    };
  }
  if (state.limits.monthlyBudgetCents && state.limits.monthlyBudgetCents > 0) {
    return {
      percent: (state.estimatedCents / state.limits.monthlyBudgetCents) * 100,
      basis: "budget",
    };
  }
  return { percent: 0, basis: "none" };
}

/** Stable fleet launch time from budget state; manifest.at is last watcher write, not fleet start. */
export function resolveFleetStartedAt(
  manifest: { at?: string } | null | undefined,
  state: { fleetStartedAt?: string },
): string | undefined {
  return state.fleetStartedAt ?? manifest?.at;
}

export function getBudgetSnapshot(
  state: BudgetState,
  fleet?: { activeWorkers: number; fleetStartedAt?: string },
): BudgetSnapshot {
  const { limits } = state;
  const warnings: string[] = [];
  const blockedActions: BudgetAction[] = [];
  const usage = usagePercent(state);

  if (usage.basis !== "none") {
    if (usage.percent >= limits.warnAtPercent) {
      warnings.push(`Usage at ${usage.percent.toFixed(1)}% of ${usage.basis} limit`);
    }
    if (usage.percent >= limits.blockAtPercent) {
      blockedActions.push("spawn_sdk", "spawn_fleet_worker", "relaunch_worker", "orchestrate_spawn");
    }
    if (usage.percent >= limits.fleetBudgetPercent) {
      blockedActions.push("spawn_fleet_worker", "relaunch_worker");
      warnings.push(`Fleet actions throttled at ${usage.percent.toFixed(1)}% (fleet cap ${limits.fleetBudgetPercent}%)`);
    }
  }

  const spawnsLastHour = spawnsInLastHour(state);
  if (spawnsLastHour >= limits.maxSpawnsPerHour) {
    blockedActions.push("spawn_sdk", "spawn_fleet_worker", "relaunch_worker", "orchestrate_spawn");
    warnings.push(`Spawn rate ${spawnsLastHour}/${limits.maxSpawnsPerHour} per hour`);
  }

  const sdkRunsLastHour = sdkRunsInLastHour(state);
  if (sdkRunsLastHour >= limits.maxSdkRunsPerHour) {
    blockedActions.push("spawn_sdk", "follow_up_sdk", "orchestrate_spawn");
    warnings.push(`SDK run rate ${sdkRunsLastHour}/${limits.maxSdkRunsPerHour} per hour`);
  }

  if (fleet && fleet.activeWorkers > limits.maxConcurrentWorkers) {
    blockedActions.push("spawn_fleet_worker", "relaunch_worker");
    warnings.push(`Active workers ${fleet.activeWorkers}/${limits.maxConcurrentWorkers}`);
  }

  if (state.relaunchCount >= limits.maxRelaunchesPerWorker * Math.max(1, fleet?.activeWorkers ?? 1)) {
    blockedActions.push("relaunch_worker");
    warnings.push(`Relaunch cap reached (${state.relaunchCount})`);
  }

  let fleetSection: BudgetSnapshot["fleet"];
  const fleetStartedAt = fleet?.fleetStartedAt ?? state.fleetStartedAt;
  if (fleetStartedAt) {
    const fleetElapsedMs = Date.now() - Date.parse(fleetStartedAt);
    const percentOfMaxDuration = (fleetElapsedMs / limits.maxFleetDurationMs) * 100;
    fleetSection = {
      activeWorkers: fleet?.activeWorkers ?? 0,
      relaunchCount: state.relaunchCount,
      fleetElapsedMs,
      maxDurationMs: limits.maxFleetDurationMs,
      percentOfMaxDuration,
      budgetBlocked: state.budgetBlocked,
    };
    if (percentOfMaxDuration >= 100) {
      blockedActions.push("relaunch_worker", "spawn_fleet_worker");
      warnings.push(`Fleet max duration exceeded (${Math.round(fleetElapsedMs / 60_000)}m)`);
    }
  }

  if (state.budgetBlocked) {
    blockedActions.push("spawn_sdk", "spawn_fleet_worker", "relaunch_worker", "orchestrate_spawn", "follow_up_sdk");
    warnings.push(state.blockedReason ?? "Budget supervisor blocked further spend");
  }

  const uniqueBlocked = [...new Set(blockedActions)];
  let status: BudgetStatus = "ok";
  if (uniqueBlocked.length > 0) status = state.budgetBlocked || usage.percent >= limits.blockAtPercent ? "blocked" : "warn";
  else if (warnings.length > 0) status = "warn";

  const snapshot: BudgetSnapshot = {
    at: new Date().toISOString(),
    status,
    warnings,
    blockedActions: uniqueBlocked,
    local: {
      estimatedCents: state.estimatedCents,
      monthlyBudgetCents: limits.monthlyBudgetCents,
      percent: usage.basis === "budget" ? usage.percent : undefined,
      sdkRuns: state.sdkRuns,
      sdkDurationMs: state.sdkDurationMs,
      sdkDurationMinutes: Math.round(state.sdkDurationMs / 60_000),
      spawnsLastHour,
      sdkRunsLastHour,
      ideTicks: state.ideTicks,
    },
    fleet: fleetSection,
    limits,
  };

  if (state.planRequestLimit && state.planUsedRequests != null) {
    snapshot.plan = {
      used: state.planUsedRequests,
      limit: state.planRequestLimit,
      percent: (state.planUsedRequests / state.planRequestLimit) * 100,
      source: state.planSource ?? "manual",
    };
  }

  return snapshot;
}

export function checkBudgetGate(
  action: BudgetAction,
  state: BudgetState,
  fleet?: { activeWorkers: number; fleetStartedAt?: string },
): BudgetGateResult {
  const snapshot = getBudgetSnapshot(state, fleet);
  if (snapshot.blockedActions.includes(action)) {
    return {
      allowed: false,
      reason: snapshot.warnings[0] ?? `Action ${action} blocked by budget policy`,
      snapshot,
    };
  }
  return { allowed: true, snapshot };
}

export class BudgetExceededError extends Error {
  readonly snapshot: BudgetSnapshot;

  constructor(message: string, snapshot: BudgetSnapshot) {
    super(message);
    this.name = "BudgetExceededError";
    this.snapshot = snapshot;
  }
}

export function assertBudgetAllowed(
  action: BudgetAction,
  state?: BudgetState,
  fleet?: { activeWorkers: number; fleetStartedAt?: string },
): BudgetSnapshot {
  const current = state ?? loadBudgetState();
  const gate = checkBudgetGate(action, current, fleet);
  if (!gate.allowed) {
    throw new BudgetExceededError(gate.reason ?? "Budget exceeded", gate.snapshot);
  }
  return gate.snapshot;
}

export function recordBudgetEvent(
  event: BudgetEvent,
  mutate?: (state: BudgetState) => void,
  path = budgetStatePath(),
): BudgetState {
  const state = loadBudgetState(path);

  switch (event.action) {
    case "spawn_sdk":
    case "spawn_fleet_worker":
    case "orchestrate_spawn":
      state.spawnCount += 1;
      break;
    case "relaunch_worker":
      state.spawnCount += 1;
      state.relaunchCount += 1;
      break;
    case "run_complete":
      state.sdkRuns += 1;
      state.sdkDurationMs += event.durationMs ?? 0;
      state.estimatedCents += event.estimatedCents ?? state.limits.estimateCentsPerSdkRun;
      break;
    case "ide_tick":
      state.ideTicks += 1;
      state.estimatedCents += event.estimatedCents ?? state.limits.estimateCentsPerIdeTick;
      break;
    case "fleet_start":
      state.fleetStartedAt = event.at;
      state.fleetStoppedAt = undefined;
      state.relaunchCount = 0;
      state.budgetBlocked = false;
      state.blockedReason = undefined;
      break;
    case "fleet_stop":
      state.fleetStoppedAt = event.at;
      break;
    case "kill_workers":
      state.budgetBlocked = true;
      state.blockedReason = event.detail ?? "Workers killed by budget supervisor";
      break;
    default:
      break;
  }

  pushEvent(state, event);
  mutate?.(state);
  saveBudgetState(state, path);
  return state;
}

export function recordSdkRunComplete(params: {
  durationMs?: number;
  model?: string;
  source?: string;
  estimatedCents?: number;
}): BudgetState {
  return recordBudgetEvent({
    at: new Date().toISOString(),
    action: "run_complete",
    durationMs: params.durationMs,
    model: params.model,
    source: params.source,
    estimatedCents: params.estimatedCents,
  });
}

export function recordSpawn(action: BudgetAction, source?: string, path = budgetStatePath()): BudgetState {
  return recordBudgetEvent(
    {
      at: new Date().toISOString(),
      action,
      source,
    },
    undefined,
    path,
  );
}

export function setPlanUsage(used: number, limit?: number, source: "env" | "manual" = "manual"): BudgetState {
  const state = loadBudgetState();
  state.planUsedRequests = used;
  if (limit != null) state.planRequestLimit = limit;
  state.planSource = source;
  saveBudgetState(state);
  return state;
}

export function resetFleetBudgetClock(path = budgetStatePath()): BudgetState {
  const state = loadBudgetState(path);
  const cutoff = Date.now() - HOUR_MS;
  // Fresh fleet launch should not inherit spawn-rate blocks from the prior hour.
  state.events = state.events.filter((event) => {
    if (Date.parse(event.at) < cutoff) return true;
    return !SPAWN_ACTIONS.includes(event.action as BudgetAction);
  });
  state.fleetStartedAt = undefined;
  state.relaunchCount = 0;
  state.budgetBlocked = false;
  state.blockedReason = undefined;
  saveBudgetState(state, path);
  return state;
}

export function blockBudget(reason: string): BudgetState {
  return recordBudgetEvent({
    at: new Date().toISOString(),
    action: "kill_workers",
    detail: reason,
  });
}

export function writeBudgetStatus(snapshot: BudgetSnapshot, path?: string): string {
  const file = path ?? join(dirname(budgetStatePath()), "budget-status.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(snapshot, null, 2));
  return file;
}
