import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  countActiveWorkers,
  loadFleetManifest,
  type FleetManifest,
} from "./budget-supervisor.js";
import { metaHome } from "./meta-home.js";
import { workspaceNameForProject } from "./project-meta.js";

export interface DashboardWorkspace {
  /** URL-safe id (base64url meta dir path). */
  id: string;
  /** Project meta root — parent of `experiments/`. */
  metaDir: string;
  experimentsDir: string;
  label: string;
  cwd?: string;
  goal?: string;
  running: boolean;
  aliveCount: number;
  totalWorkers: number;
  hasManifest: boolean;
  manifestAt?: string;
}

export interface DashboardContext {
  metaDir: string;
  experimentsDir: string;
  fleetCwd: string;
  workspace: string;
  workspaceId: string;
}

function encodeWorkspaceId(metaDir: string): string {
  return Buffer.from(resolve(metaDir), "utf8").toString("base64url");
}

export function decodeWorkspaceId(id: string | null | undefined): string | null {
  if (!id?.trim()) return null;
  try {
    return resolve(Buffer.from(id.trim(), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function experimentsDirForMeta(metaDir: string): string {
  return join(resolve(metaDir), "experiments");
}

function hasFleetActivity(experimentsDir: string): boolean {
  if (!existsSync(experimentsDir)) return false;
  if (existsSync(join(experimentsDir, "manifest.json"))) return true;
  try {
    return readdirSync(experimentsDir).some(
      (name) =>
        /^sdk-worker/.test(name) ||
        name === "watch-status.json" ||
        name === "strategy-status.json" ||
        name.endsWith(".log"),
    );
  } catch {
    return false;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fleetRunning(manifest: FleetManifest | null, aliveCount: number): boolean {
  if (!manifest) return aliveCount > 0;
  return (
    aliveCount > 0 ||
    pidAlive(manifest.watcherPid) ||
    pidAlive(manifest.strategyReviewerPid)
  );
}

function labelForWorkspace(metaDir: string, manifest: FleetManifest | null): string {
  if (manifest?.root?.trim()) {
    return workspaceNameForProject(manifest.root);
  }
  const slug = basename(resolve(metaDir));
  if (slug === ".cursor-meta" || slug === "projects") return "Global fleet";
  return slug.replace(/-[a-f0-9]{10}$/i, "") || slug;
}

function summarizeWorkspace(metaDir: string): DashboardWorkspace | null {
  const resolvedMeta = resolve(metaDir);
  const experimentsDir = experimentsDirForMeta(resolvedMeta);
  if (!hasFleetActivity(experimentsDir)) return null;

  const manifest = loadFleetManifest(experimentsDir);
  const experiments = manifest?.experiments ?? [];
  const aliveCount = experiments.filter((row) => pidAlive(row.pid)).length;
  const activeWorkers = countActiveWorkers(manifest);

  return {
    id: encodeWorkspaceId(resolvedMeta),
    metaDir: resolvedMeta,
    experimentsDir,
    label: labelForWorkspace(resolvedMeta, manifest),
    cwd: manifest?.root,
    goal: manifest?.goal,
    running: fleetRunning(manifest, Math.max(aliveCount, activeWorkers)),
    aliveCount: Math.max(aliveCount, activeWorkers),
    totalWorkers: experiments.length,
    hasManifest: manifest != null,
    manifestAt: manifest?.at,
  };
}

export function listDashboardWorkspaces(home = metaHome()): DashboardWorkspace[] {
  const seen = new Set<string>();
  const workspaces: DashboardWorkspace[] = [];

  const add = (metaDir: string) => {
    const resolved = resolve(metaDir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const row = summarizeWorkspace(resolved);
    if (row) workspaces.push(row);
  };

  add(home);

  const projectsDir = join(home, "projects");
  if (existsSync(projectsDir)) {
    for (const name of readdirSync(projectsDir)) {
      if (name.startsWith(".")) continue;
      add(join(projectsDir, name));
    }
  }

  return workspaces.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    const aMs = a.manifestAt ? Date.parse(a.manifestAt) : 0;
    const bMs = b.manifestAt ? Date.parse(b.manifestAt) : 0;
    if (aMs !== bMs) return bMs - aMs;
    return a.label.localeCompare(b.label);
  });
}

export function resolveDashboardContext(params: {
  workspaceId?: string | null;
  metaDir?: string | null;
  defaultMetaDir: string;
  defaultCwd: string;
  defaultWorkspace: string;
}): DashboardContext {
  const fromId = decodeWorkspaceId(params.workspaceId);
  const fromMeta = params.metaDir?.trim() ? resolve(params.metaDir.trim()) : null;
  const metaDir = fromId ?? fromMeta ?? resolve(params.defaultMetaDir);
  const experimentsDir = experimentsDirForMeta(metaDir);
  const manifest = loadFleetManifest(experimentsDir);

  const fleetCwd = manifest?.root?.trim() || params.defaultCwd;
  const workspace =
    manifest?.root?.trim()
      ? workspaceNameForProject(manifest.root)
      : params.defaultWorkspace;

  return {
    metaDir,
    experimentsDir,
    fleetCwd,
    workspace,
    workspaceId: encodeWorkspaceId(metaDir),
  };
}

export function pickDefaultWorkspaceId(
  workspaces: DashboardWorkspace[],
  preferredId?: string | null,
): string | undefined {
  if (preferredId && workspaces.some((row) => row.id === preferredId)) {
    return preferredId;
  }
  return workspaces.find((row) => row.running)?.id ?? workspaces[0]?.id;
}
