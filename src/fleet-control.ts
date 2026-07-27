import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadFleetManifest, type FleetManifest } from "./budget-supervisor.js";

function killPid(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Collect unique positive pids from manifest (experiments + top-level watcher/reviewer). */
export function collectFleetPids(manifest: FleetManifest): number[] {
  const seen = new Set<number>();
  const pids: number[] = [];
  const add = (pid: number | undefined) => {
    if (!pid || pid <= 0 || seen.has(pid)) return;
    seen.add(pid);
    pids.push(pid);
  };
  for (const exp of manifest.experiments) add(exp.pid);
  add(manifest.watcherPid);
  add(manifest.strategyReviewerPid);
  return pids;
}

export function stopFleetProcesses(metaDir?: string): { killed: number[]; manifest: FleetManifest | null } {
  const dir = metaDir ?? join(homedir(), ".cursor-meta", "experiments");
  const manifest = loadFleetManifest(dir);
  const killed: number[] = [];

  if (!manifest) {
    return { killed, manifest: null };
  }

  for (const pid of collectFleetPids(manifest)) {
    if (killPid(pid)) killed.push(pid);
  }

  return { killed, manifest };
}

/** Best-effort stop of any detached fleet/watcher processes for this repo. */
export function stopKnownFleetProcesses(metaDir?: string): number[] {
  const { killed } = stopFleetProcesses(metaDir);
  return killed;
}

export function readDedicatedWorker(metaDir: string): { sessionId?: string; sessionIndex?: number | null } | null {
  const path = join(metaDir, "dedicated-worker.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { sessionId?: string; sessionIndex?: number | null };
  } catch {
    return null;
  }
}
