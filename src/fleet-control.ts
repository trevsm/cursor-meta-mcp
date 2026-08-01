import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadFleetManifest, type FleetManifest } from "./budget-supervisor.js";
import { experimentsDir } from "./meta-home.js";

/**
 * Stop a fleet process and everything it spawned.
 *
 * Workers shell out to long-running builds (`turbo run build`, test runners).
 * Signalling the pid alone leaves those children running against a worktree the
 * fleet believes is idle, so a "stopped" fleet keeps burning CPU and holding
 * file locks. Every fleet process is spawned `detached: true`, which makes it a
 * process-group leader — signal the negative pid to take the group with it.
 */
export function killPid(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  let signalled = false;
  try {
    process.kill(-pid, "SIGTERM");
    signalled = true;
  } catch {
    /* not a group leader (or already gone) — fall back to the bare pid */
  }
  try {
    process.kill(pid, "SIGTERM");
    signalled = true;
  } catch {
    /* already exited */
  }
  return signalled;
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
  const dir = metaDir ?? experimentsDir();
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

/** SIGTERM a manifest experiment by IDE session index (strategy `kill[]` actuation). */
export function killExperimentBySessionIndex(
  manifest: FleetManifest,
  sessionIndex: number,
): { killed: boolean; pid?: number; name?: string } {
  const exp = manifest.experiments.find((row) => row.sessionIndex === sessionIndex);
  if (!exp?.pid) return { killed: false };
  return { killed: killPid(exp.pid), pid: exp.pid, name: exp.name };
}

/** SIGTERM a manifest experiment by name (headless sdk-worker actuation). */
export function killExperimentByName(
  manifest: FleetManifest,
  name: string,
): { killed: boolean; pid?: number; name?: string } {
  const exp = manifest.experiments.find((row) => row.name === name);
  if (!exp?.pid) return { killed: false, name };
  return { killed: killPid(exp.pid), pid: exp.pid, name: exp.name };
}

export function killExperimentsByName(manifest: FleetManifest, names: string[]): number[] {
  const killed: number[] = [];
  for (const name of names) {
    const result = killExperimentByName(manifest, name);
    if (result.killed && result.pid) killed.push(result.pid);
  }
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
