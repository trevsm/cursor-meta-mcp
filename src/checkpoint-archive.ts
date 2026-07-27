import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { analyzeWorkerCheckpoint, type WorkerCheckpointState } from "./fleet-metrics.js";

export interface ArchivedWorkerSession {
  path: string;
  startedAt?: string;
  stoppedBecause?: string;
  ticks: number;
  productiveTicks: number;
  productiveRatio: number;
  archivedAt?: string;
}

export function archiveCheckpointPath(checkpointPath: string, startedAt?: string): string {
  const dir = dirname(checkpointPath);
  const base = basename(checkpointPath, ".json");
  const stamp = (startedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
  return join(dir, `${base}.session-${stamp}.json`);
}

function readCheckpointState(path: string): WorkerCheckpointState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkerCheckpointState;
  } catch {
    return null;
  }
}

/** Copy checkpoint to a timestamped session file when it contains completed work. */
export function archiveWorkerCheckpointIfNeeded(checkpointPath: string): string | null {
  const state = readCheckpointState(checkpointPath);
  if (!state) return null;
  const tickCount = state.ticks?.length ?? 0;
  if (tickCount === 0 && !state.stoppedBecause) return null;

  const archivePath = archiveCheckpointPath(checkpointPath, state.startedAt);
  if (existsSync(archivePath)) return archivePath;

  copyFileSync(checkpointPath, archivePath);
  return archivePath;
}

export function listArchivedWorkerSessions(checkpointPath: string, limit = 5): ArchivedWorkerSession[] {
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) return [];

  const base = basename(checkpointPath, ".json");
  const prefix = `${base}.session-`;
  const rows: ArchivedWorkerSession[] = [];

  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    const metrics = analyzeWorkerCheckpoint(path);
    const state = readCheckpointState(path);
    if (!metrics || !state) continue;
    rows.push({
      path,
      startedAt: state.startedAt,
      stoppedBecause: state.stoppedBecause,
      ticks: metrics.ticks,
      productiveTicks: metrics.productiveTicks,
      productiveRatio: metrics.productiveRatio,
      archivedAt: statSync(path).mtime.toISOString(),
    });
  }

  return rows
    .sort((a, b) => Date.parse(b.archivedAt ?? "") - Date.parse(a.archivedAt ?? ""))
    .slice(0, limit);
}

export function formatArchivedSessionSummary(session: ArchivedWorkerSession): string {
  const pct = (session.productiveRatio * 100).toFixed(0);
  const stop = session.stoppedBecause ?? "complete";
  return `${session.ticks} ticks (${pct}% productive, stopped: ${stop})`;
}
