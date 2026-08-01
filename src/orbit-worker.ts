import { basename, dirname } from "node:path";

import {
  blockMission,
  claimNextMission,
  fileMission,
  formatMissionForPrompt,
  verifyMission,
  readMissions,
  stationId,
  summarizeStation,
  updateMission,
  type Mission,
} from "./orbit-ledger.js";

export const ORBIT_ENV = "CURSOR_META_ORBIT";

/** Fleet manifests live in `<project-meta>/experiments`; Orbit lives one level up. */
export function orbitMetaDirForFleet(fleetMetaDir: string): string {
  return basename(fleetMetaDir) === "experiments" ? dirname(fleetMetaDir) : fleetMetaDir;
}

/** True when orbit mission mode is active for this worker run. */
export function orbitEnabled(metaDir?: string, cwd?: string): boolean {
  const raw = process.env[ORBIT_ENV]?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return false;
  if (raw === "1" || raw === "on" || raw === "true") return true;
  if (!cwd?.trim()) return false;
  const summary = summarizeStation(stationId(cwd), metaDir);
  return summary.total > 0;
}

/** Derive worker id from checkpoint filename, e.g. sdk-worker-1.json → sdk-worker-1. */
export function workerIdFromCheckpoint(checkpointPath?: string): string {
  if (!checkpointPath?.trim()) return "sdk-worker-main";
  const name = basename(checkpointPath).replace(/\.json$/i, "");
  return name || "sdk-worker-main";
}

export interface OrbitTickContext {
  station: string;
  workerId: string;
  metaDir?: string;
}

export interface OrbitTickPrep {
  mission: Mission | null;
  /** When true the coder should exit — no claimable work remains. */
  exitDrained: boolean;
}

/** Claim or resume a mission before a tick runs. */
export function prepareOrbitTick(ctx: OrbitTickContext): OrbitTickPrep {
  const mission = claimNextMission(ctx.station, ctx.workerId, ctx.metaDir);
  if (!mission) {
    return { mission: null, exitDrained: summarizeStation(ctx.station, ctx.metaDir).drained };
  }
  if (mission.status === "claimed") {
    updateMission(ctx.station, mission.id, { status: "active" }, ctx.metaDir);
    return { mission: { ...mission, status: "active" }, exitDrained: false };
  }
  return { mission, exitDrained: false };
}

export function missionPromptBlock(mission: Mission | null): string {
  return formatMissionForPrompt(mission);
}

export interface OrbitTickFinalizeInput {
  ctx: OrbitTickContext;
  mission: Mission;
  error?: string;
  outcome?: {
    commits?: number;
    filesChanged?: number;
    tests?: { passed?: boolean; command?: string };
  };
  tickReportDone?: boolean;
}

/** Update mission state after a tick — block on infra errors, land on verified completion. */
export function finalizeOrbitTick(input: OrbitTickFinalizeInput): Mission | null {
  const { ctx, mission, error, outcome, tickReportDone } = input;

  if (error) {
    if (/SDK run rate/i.test(error)) {
      blockMission(ctx.station, mission.id, error, ctx.metaDir);
    }
    return getMissionFresh(ctx, mission.id);
  }

  const verifyPassed = outcome?.tests?.passed === true;
  const hasCommits = (outcome?.commits ?? 0) > 0;
  const headAfter = (outcome as { headAfter?: string } | undefined)?.headAfter;
  const readyToLand = verifyPassed && (hasCommits || tickReportDone === true);

  if (!readyToLand) return getMissionFresh(ctx, mission.id);

  const commitShas: string[] = [];
  if (headAfter) commitShas.push(headAfter);

  // Verified, not landed. The watcher promotes this once the branch actually
  // merges — see landVerifiedMission.
  const verified = verifyMission(
    ctx.station,
    mission.id,
    {
      commits: commitShas,
      verifyOnly: commitShas.length === 0 && verifyPassed,
      filesChanged: outcome?.filesChanged,
      tests: { passed: true, command: outcome?.tests?.command },
    },
    ctx.metaDir,
  );

  return verified.mission ?? getMissionFresh(ctx, mission.id);
}

function getMissionFresh(ctx: OrbitTickContext, id: string): Mission | null {
  return readMissions(ctx.station, ctx.metaDir).find((row) => row.id === id) ?? null;
}

/** File the launch goal as the first open mission when orbit mode starts with an empty ledger. */
export function ensureLaunchMission(input: {
  cwd: string;
  goal: string;
  verify?: string;
  metaDir?: string;
}): Mission | null {
  const station = stationId(input.cwd);
  const summary = summarizeStation(station, input.metaDir);
  if (summary.total > 0) return summary.next ?? summary.active;

  const goal = input.goal.trim();
  if (!goal) return null;

  const title = goal.length > 80 ? `${goal.slice(0, 77)}…` : goal;
  return fileMission(
    {
      station,
      title,
      intent: goal,
      verify: input.verify,
      acceptance: ["Local verify passes", "Changes committed when slice is green"],
    },
    input.metaDir,
  );
}
