import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runFleetPreflight } from "./fleet-preflight.js";
import { metaHome, metaPath } from "./meta-home.js";
import {
  experimentsDirForProject,
  projectMetaDir,
  projectSlug,
  resolveProjectRoot,
  workspaceNameForProject,
} from "./project-meta.js";
import {
  DEFAULT_AGI_ARCHITECTURE,
  mergeAgiArchitecture,
  type AgiArchitecture,
} from "./agi-architecture.js";
import {
  launchSelfImproveFleet,
  type FleetLauncher,
  type SelfImproveManifest,
  type SelfImproveParams,
} from "./self-improve.js";
import { pushGoal, setNorthStar } from "./world-model.js";

export interface ActiveAgiSession {
  cwd: string;
  task: string;
  projectSlug: string;
  projectMetaDir: string;
  experimentsDir: string;
  workspace: string;
  startedAt: string;
  /** Stable mission id (HumanLayer/CodeLayer session). */
  sessionId: string;
  /** Per fleet launch / relaunch (CodeLayer run). */
  runId: string;
  architecture?: AgiArchitecture;
}

export interface AgiMissionParams {
  cwd: string;
  task: string;
  excludeSessionIndex?: number;
  durationMs?: number;
  withOrchestrator?: boolean;
  withWatcher?: boolean;
  withStrategyReviewer?: boolean;
  strategyReviewIntervalMs?: number;
  workerMode?: SelfImproveParams["workerMode"];
  parallelWorkers?: number;
  stopExisting?: boolean;
  freshStart?: boolean;
  resumeWorkers?: boolean;
  requireApiKey?: boolean;
  dashboardPort?: number;
  prompt?: string;
  architecture?: Partial<AgiArchitecture>;
}

export interface AgiMissionResult {
  ok: true;
  session: ActiveAgiSession;
  manifest: SelfImproveManifest;
  preflightWarnings: string[];
  dashboardUrl: string;
  dashboardCommand: string;
}

const ACTIVE_AGI_PATH = () => metaPath("active-agi.json");

export function buildAgiWorkerPrompt(task: string): string {
  const mission = task.trim();
  return [
    `Mission: ${mission}`,
    "",
    "Keep going autonomously until this mission is fully complete. Do not stop or ask the user for moves.",
    "Break the mission into small verified steps — one step per tick.",
    "Verify code changes with npm run test:fast when the project has it; otherwise npm test.",
    "Minimize scope per tick; ship verified progress toward the mission.",
    "Do not drift into meta-discussion or architecture theater — implement toward the mission.",
    "When blocked twice on the same path, change approach (decomposition, verification, or tooling) — do not loop.",
    "When the mission is done, run final verification and stop claiming partial work as complete.",
  ].join("\n");
}

export function readActiveAgiSession(): ActiveAgiSession | null {
  const path = ACTIVE_AGI_PATH();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ActiveAgiSession>;
    if (!parsed.cwd?.trim() || !parsed.task?.trim() || !parsed.experimentsDir?.trim()) return null;
    if (!parsed.sessionId) parsed.sessionId = randomUUID();
    if (!parsed.runId) parsed.runId = randomUUID();
    return parsed as ActiveAgiSession;
  } catch {
    return null;
  }
}

export function writeActiveAgiSession(session: ActiveAgiSession): void {
  mkdirSync(dirname(ACTIVE_AGI_PATH()), { recursive: true });
  writeFileSync(ACTIVE_AGI_PATH(), JSON.stringify(session, null, 2));
}

export function persistProjectMission(cwd: string, task: string): void {
  const dir = projectMetaDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "mission.json"),
    JSON.stringify(
      {
        cwd: resolveProjectRoot(cwd),
        task: task.trim(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function buildDashboardCommand(cwd: string, port = 3847): string {
  const root = resolveProjectRoot(cwd);
  const workspace = workspaceNameForProject(root);
  const meta = projectMetaDir(root);
  return `npm run dashboard -- --cwd ${JSON.stringify(root)} --workspace ${JSON.stringify(workspace)} --meta-dir ${JSON.stringify(meta)} --port ${port}`;
}

export async function launchAgiMission(
  params: AgiMissionParams,
  launch: FleetLauncher = launchSelfImproveFleet,
): Promise<AgiMissionResult> {
  const cwd = resolveProjectRoot(params.cwd);
  const task = params.task.trim();
  if (!task) {
    throw new Error("task is required.");
  }

  const preflight = await runFleetPreflight({
    cwd,
    requireApiKey: params.requireApiKey ?? true,
    skipSmokeTest: true,
  });
  if (!preflight.ok) {
    throw new Error(preflight.failures.join("; "));
  }

  const experimentsDir = experimentsDirForProject(cwd);
  mkdirSync(experimentsDir, { recursive: true });
  persistProjectMission(cwd, task);

  const prior = readActiveAgiSession();
  const sameProject = prior && resolveProjectRoot(prior.cwd) === cwd;
  const sessionId = sameProject && prior.sessionId ? prior.sessionId : randomUUID();
  const runId = randomUUID();
  const architecture = mergeAgiArchitecture(
    mergeAgiArchitecture(
      DEFAULT_AGI_ARCHITECTURE,
      prior && resolveProjectRoot(prior.cwd) === cwd ? prior.architecture : undefined,
    ),
    params.architecture,
  );
  if (params.workerMode != null) architecture.workerMode = params.workerMode;
  if (params.parallelWorkers != null) architecture.parallelWorkers = params.parallelWorkers;
  if (params.withOrchestrator != null) architecture.withOrchestrator = params.withOrchestrator;
  if (params.withWatcher != null) architecture.withWatcher = params.withWatcher;
  if (params.withStrategyReviewer != null) {
    architecture.withStrategyReviewer = params.withStrategyReviewer;
  }
  if (params.strategyReviewIntervalMs != null) {
    architecture.strategyReviewIntervalMs = params.strategyReviewIntervalMs;
  }

  const session: ActiveAgiSession = {
    cwd,
    task,
    projectSlug: projectSlug(cwd),
    projectMetaDir: projectMetaDir(cwd),
    experimentsDir,
    workspace: workspaceNameForProject(cwd),
    startedAt: new Date().toISOString(),
    sessionId,
    runId,
    architecture,
  };
  writeActiveAgiSession(session);

  const workerPrompt = params.prompt?.trim() || buildAgiWorkerPrompt(task);
  const manifest = await launch({
    cwd,
    metaDir: experimentsDir,
    goal: task,
    prompt: workerPrompt,
    excludeSessionIndex: params.excludeSessionIndex ?? 1,
    durationMs: params.durationMs,
    withOrchestrator: architecture.withOrchestrator,
    withWatcher: architecture.withWatcher,
    withStrategyReviewer: architecture.withStrategyReviewer,
    strategyReviewIntervalMs: architecture.strategyReviewIntervalMs,
    workerMode: architecture.workerMode,
    parallelWorkers: architecture.parallelWorkers,
    stopExisting: params.stopExisting ?? true,
    freshStart: params.freshStart ?? true,
    resumeWorkers: params.resumeWorkers,
  });

  try {
    const worldMeta = metaHome();
    setNorthStar(task.slice(0, 240), worldMeta);
    pushGoal(task, worldMeta);
  } catch {
    /* world model is best-effort */
  }

  const port = params.dashboardPort ?? 3847;
  return {
    ok: true,
    session,
    manifest,
    preflightWarnings: preflight.warnings,
    dashboardUrl: `http://127.0.0.1:${port}/`,
    dashboardCommand: buildDashboardCommand(cwd, port),
  };
}
