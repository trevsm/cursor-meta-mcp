import { existsSync, readFileSync, readdirSync } from "node:fs";

import { friendlyExperimentName } from "./fleet-labels.js";
import type { DashboardExperimentRow } from "./dashboard.js";
import { tailRunEvents } from "./run-events.js";
import { describeTickOutcome, type TickOutcome } from "./tick-outcome.js";

export interface WorkerTickBreakdown {
  tick: number;
  at?: string;
  durationMs?: number;
  producedWork?: boolean;
  committed?: boolean;
  pushed?: boolean;
  commits?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  testsPassed?: boolean;
  testTotal?: number;
  error?: string;
  outcomeSummary?: string;
  workSummary?: string;
}

export interface WorkerLiveEvent {
  at?: string;
  kind: "thinking" | "assistant" | "tool" | "status" | "error" | "other";
  text: string;
}

export interface WorkerActivityBreakdown {
  name: string;
  displayName: string;
  alive: boolean;
  role: string;
  status: "active" | "idle" | "error" | "dead";
  statusText: string;
  ticksCompleted: number;
  productiveRatio?: number;
  recentTicks: WorkerTickBreakdown[];
  liveEvents: WorkerLiveEvent[];
}

const WORKER_ROLES: Record<string, string> = {
  "strategy-review-loop": "Reviews fleet health every 5 minutes",
  "watch-experiments": "Patrols workers, budget, and relaunch gates",
  "orchestrator-loop": "Pulse orchestrator for IDE sessions",
};

interface CheckpointTick {
  tick: number;
  at?: string;
  watchedMs?: number;
  error?: string;
  outcome?: TickOutcome;
  lastAssistantTail?: string;
}

function readCheckpointTicks(path?: string): CheckpointTick[] {
  if (!path || !existsSync(path)) return [];
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { ticks?: CheckpointTick[] };
    return state.ticks ?? [];
  } catch {
    return [];
  }
}

export function extractWorkSummary(tail?: string): string | undefined {
  if (!tail?.trim()) return undefined;
  for (const line of tail.split(/\r?\n/)) {
    const text = line.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
    if (!text || text.startsWith("#")) continue;
    if (/^ground[- ]truth:/i.test(text)) break;
    if (/^tick \d+/i.test(text) && text.includes("—")) return text.slice(0, 180);
    if (text.length > 12) return text.slice(0, 180);
  }
  return undefined;
}

function mapLiveEventKind(type: string): WorkerLiveEvent["kind"] {
  if (type === "thinking") return "thinking";
  if (type === "assistant") return "assistant";
  if (type === "tool_call") return "tool";
  if (type === "status") return "status";
  return "other";
}

function tickBreakdown(entry: CheckpointTick): WorkerTickBreakdown {
  const outcome = entry.outcome;
  return {
    tick: entry.tick,
    at: entry.at,
    durationMs: entry.watchedMs,
    producedWork: outcome?.producedWork,
    committed: outcome?.committed,
    pushed: outcome?.pushed,
    commits: outcome?.commits,
    filesChanged: outcome?.filesChanged,
    insertions: outcome?.insertions,
    deletions: outcome?.deletions,
    testsPassed: outcome?.tests?.passed,
    testTotal: outcome?.tests?.total,
    error: entry.error,
    outcomeSummary: outcome ? describeTickOutcome(outcome) : entry.error ? "error" : undefined,
    workSummary: extractWorkSummary(entry.lastAssistantTail),
  };
}

function liveEventsForAgent(agentId: string | undefined, metaDir?: string, max = 8): WorkerLiveEvent[] {
  if (!agentId || !metaDir) return [];
  const runsDir = `${metaDir}/runs`;
  if (!existsSync(runsDir)) return [];
  const events: WorkerLiveEvent[] = [];
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const runId = name.slice(0, -".jsonl".length);
    const rows = tailRunEvents(runId, { metaDir, maxLines: max });
    if (!rows.some((row) => row.agentId === agentId)) continue;
    for (const row of rows.filter((r) => r.agentId === agentId).slice(-max)) {
      events.push({ at: row.at, kind: mapLiveEventKind(row.type), text: row.message });
    }
  }
  return events.sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? "")).slice(0, max);
}

export function buildWorkerActivity(
  experiments: DashboardExperimentRow[],
  options?: { metaDir?: string; strategyStatus?: Record<string, unknown> | null },
): WorkerActivityBreakdown[] {
  const metaDir = options?.metaDir;
  const rows: WorkerActivityBreakdown[] = [];

  for (const exp of experiments) {
    const displayName = exp.displayName ?? friendlyExperimentName(exp.name);
    const cp = exp.checkpoint;
    const last = cp?.lastTick;
    const err = last?.error?.trim();
    const alive = exp.alive;
    const status: WorkerActivityBreakdown["status"] = !alive
      ? "dead"
      : err
        ? "error"
        : last?.skipped === "busy"
          ? "active"
          : "idle";

    if (exp.name.startsWith("sdk-worker")) {
      const ticks = readCheckpointTicks(exp.checkpointPath).slice(-5).reverse().map(tickBreakdown);
      const liveEvents = liveEventsForAgent(exp.agentId, metaDir);
      const activeRun = liveEvents.some(
        (event) => event.at && Date.now() - Date.parse(event.at) < 120_000,
      );
      rows.push({
        name: exp.name,
        displayName,
        alive,
        role: WORKER_ROLES[exp.name] ?? "Ships verified diffs: test → commit → push",
        status: activeRun ? "active" : status,
        statusText: err
          ? err.slice(0, 160)
          : activeRun
            ? (liveEvents[0]?.text ?? "Running SDK tick…")
            : (ticks[0]?.workSummary ??
              ticks[0]?.outcomeSummary ??
              (cp?.ticks ? `Tick ${cp.ticks} complete, awaiting next interval` : "Starting…")),
        ticksCompleted: cp?.ticks ?? 0,
        productiveRatio: cp?.productiveRatio,
        recentTicks: ticks,
        liveEvents,
      });
      continue;
    }

    if (exp.name === "strategy-review-loop") {
      const strat = options?.strategyStatus;
      rows.push({
        name: exp.name,
        displayName,
        alive,
        role: WORKER_ROLES[exp.name] ?? "Strategy review",
        status: alive ? "idle" : "dead",
        statusText:
          typeof strat?.recommendation === "string" && strat.recommendation.trim()
            ? strat.recommendation
            : alive
              ? "Waiting for next review interval"
              : "Stopped",
        ticksCompleted: 0,
        recentTicks: [],
        liveEvents: [],
      });
      continue;
    }

    rows.push({
      name: exp.name,
      displayName,
      alive,
      role: WORKER_ROLES[exp.name] ?? "Fleet supervisor",
      status,
      statusText: alive ? "Supervisor running" : "Stopped",
      ticksCompleted: cp?.ticks ?? 0,
      recentTicks: [],
      liveEvents: [],
    });
  }

  return rows.sort((a, b) => {
    const rank = (row: WorkerActivityBreakdown) =>
      row.name.startsWith("sdk-worker") ? 0 : row.name === "strategy-review-loop" ? 1 : 2;
    return rank(a) - rank(b);
  });
}
