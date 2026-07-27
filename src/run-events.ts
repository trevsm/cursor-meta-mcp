import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { metaHome } from "./meta-home.js";
import type { RunProgressEvent } from "./cursor-local.js";

export interface RunEventRecord extends RunProgressEvent {
  at: string;
  runId: string;
  agentId?: string;
}

export interface RunEventSource {
  runId: string;
  agentId?: string;
  path: string;
  modifiedAt: string;
  bytes: number;
}

export function defaultRunsDir(metaDir = metaHome()): string {
  return join(metaDir, "runs");
}

export function appendRunEvent(
  runId: string,
  event: RunProgressEvent,
  options?: { metaDir?: string; agentId?: string },
): void {
  const dir = defaultRunsDir(options?.metaDir);
  mkdirSync(dir, { recursive: true });
  const record: RunEventRecord = {
    ...event,
    at: new Date().toISOString(),
    runId,
    agentId: options?.agentId,
  };
  appendFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

export function tailRunEvents(
  runId: string,
  options?: { metaDir?: string; maxLines?: number; since?: string },
): RunEventRecord[] {
  const path = join(defaultRunsDir(options?.metaDir), `${runId}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const sinceMs = options?.since ? Date.parse(options.since) : 0;
  const records = lines
    .map((line) => {
      try {
        return JSON.parse(line) as RunEventRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is RunEventRecord => record != null)
    .filter((record) => !sinceMs || Date.parse(record.at) > sinceMs);
  const max = options?.maxLines ?? 80;
  return records.slice(-max);
}

export function listRunEventSources(metaDir?: string): RunEventSource[] {
  const dir = defaultRunsDir(metaDir);
  if (!existsSync(dir)) return [];
  const sources: RunEventSource[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      const runId = name.slice(0, -".jsonl".length);
      let agentId: string | undefined;
      const firstLine = readFileSync(path, "utf8").split(/\r?\n/).find(Boolean);
      if (firstLine) {
        try {
          agentId = (JSON.parse(firstLine) as RunEventRecord).agentId;
        } catch {
          /* ignore */
        }
      }
      sources.push({
        runId,
        agentId,
        path,
        modifiedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      });
    } catch {
      /* skip */
    }
  }
  return sources.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

export function recentRunThoughts(
  metaDir?: string,
  maxRuns = 6,
  maxEventsPerRun = 12,
  maxAgeMs = 10 * 60_000,
): Array<{ runId: string; agentId?: string; events: RunEventRecord[]; modifiedAt: string }> {
  const cutoff = Date.now() - maxAgeMs;
  return listRunEventSources(metaDir)
    .filter((source) => Date.parse(source.modifiedAt) >= cutoff)
    .slice(0, maxRuns)
    .map((source) => ({
      runId: source.runId,
      agentId: source.agentId,
      modifiedAt: source.modifiedAt,
      events: tailRunEvents(source.runId, { metaDir, maxLines: maxEventsPerRun }),
    }))
    .filter((row) => row.events.length > 0);
}
