import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import { metaHome } from "./meta-home.js";

/**
 * Orbit work ledger — durable, claimable units of work for fleet coders.
 *
 * Fleets previously carried their goal as a prompt string, so nothing could ever
 * transition to done: workers ticked until a duration expired and supervisors
 * replayed stale directives forever. A mission is the missing primitive — it is
 * claimed by exactly one coder, gated on verified evidence, and can close.
 *
 * Records append as JSONL (crash-safe, free audit trail); later records for the
 * same id supersede earlier ones.
 */

export type MissionStatus =
  | "open"
  | "claimed"
  | "active"
  | "verified"
  | "landed"
  | "blocked"
  | "dropped";

export type MissionSeverity = "low" | "normal" | "high";

export interface MissionEvidence {
  /** Commit SHAs produced for this mission. */
  commits: string[];
  filesChanged?: number;
  tests?: { passed: boolean; command?: string };
  /** True when verify passed but batch policy held commits for a later tick. */
  verifyOnly?: boolean;
}

export interface Mission {
  /** Station prefix + 5 chars, e.g. `fa-a3k91`. */
  id: string;
  title: string;
  /** The why. Surfaced verbatim by the dashboard overview. */
  intent: string;
  status: MissionStatus;
  acceptance: string[];
  /** Command that must pass before the mission can land. */
  verify?: string;
  station: string;
  branch?: string;
  claimedBy?: string;
  claimedAt?: string;
  blockedReason?: string;
  severity?: MissionSeverity;
  /** Groups related missions; replaces ad-hoc goal nesting. */
  parent?: string;
  /**
   * Subsystem this mission touches, e.g. `api` or `web-auth`. At most one coder
   * holds a lane at a time, so concurrent missions never share files.
   */
  lane?: string;
  /** Mission ids that must be landed before this one can be claimed. */
  dependsOn?: string[];
  evidence?: MissionEvidence;
  createdAt: string;
  updatedAt: string;
  landedAt?: string;
}

export interface MissionSummary {
  station: string;
  total: number;
  open: number;
  inFlight: number;
  landed: number;
  blocked: number;
  dropped: number;
  /** Mission a coder is currently holding, if any. */
  active: Mission | null;
  /** Next mission a coder would claim. */
  next: Mission | null;
  /** True when no claimable work remains — the signal to retire a coder. */
  drained: boolean;
}

const TERMINAL: MissionStatus[] = ["landed", "dropped"];
const IN_FLIGHT: MissionStatus[] = ["claimed", "active", "verified"];

const ALLOWED_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  open: ["claimed", "dropped", "blocked"],
  // `active` is optional progress metadata: a coder that claims, works, and
  // verifies in one pass should not be forced through it to land.
  claimed: ["active", "verified", "open", "blocked", "dropped"],
  active: ["verified", "blocked", "open", "dropped"],
  verified: ["landed", "active", "blocked"],
  blocked: ["open", "claimed", "active", "dropped"],
  landed: [],
  dropped: ["open"],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Stable station id for a target repo path. */
export function stationId(cwd: string): string {
  const name = basename(resolve(cwd)) || "station";
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "station";
}

/** Two-letter mission id prefix derived from the station name. */
export function stationPrefix(station: string): string {
  const letters = station.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!letters) return "ms";
  return letters.slice(0, 2).padEnd(2, "x");
}

export function orbitDir(metaDir?: string): string {
  return join(metaDir ?? metaHome(), "orbit");
}

export function missionsPath(station: string, metaDir?: string): string {
  return join(orbitDir(metaDir), station, "missions.jsonl");
}

function ledgerLockPath(station: string, metaDir?: string): string {
  return join(orbitDir(metaDir), station, ".missions.lock");
}

/**
 * Short mutual-exclusion section around read-modify-append.
 *
 * Uses `wx` rather than the pid-based process lock: that primitive models
 * long-lived role singletons, while claims need a sub-second critical section
 * that a crashed holder cannot wedge shut.
 */
function withLedgerLock<T>(station: string, metaDir: string | undefined, fn: () => T): T {
  const path = ledgerLockPath(station, metaDir);
  mkdirSync(join(path, ".."), { recursive: true });

  const staleMs = 10_000;
  const deadline = Date.now() + 5_000;
  let held = false;

  while (!held) {
    try {
      closeSync(openSync(path, "wx"));
      held = true;
    } catch {
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs > staleMs) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for mission ledger lock on station ${station}`);
      }
      // Busy-wait: contention windows here are sub-millisecond file appends.
      const spinUntil = Date.now() + 25;
      while (Date.now() < spinUntil) {
        /* spin */
      }
    }
  }

  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}

/** Read all missions for a station; later records supersede earlier ones. */
export function readMissions(station: string, metaDir?: string): Mission[] {
  const path = missionsPath(station, metaDir);
  if (!existsSync(path)) return [];

  const byId = new Map<string, Mission>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as Mission;
      if (record?.id) byId.set(record.id, record);
    } catch {
      // Skip torn or corrupt lines rather than losing the whole ledger.
    }
  }

  return [...byId.values()];
}

export function getMission(station: string, id: string, metaDir?: string): Mission | null {
  return readMissions(station, metaDir).find((mission) => mission.id === id) ?? null;
}

function appendRecord(station: string, mission: Mission, metaDir?: string): void {
  const path = missionsPath(station, metaDir);
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(mission)}\n`, "utf8");
}

function nextMissionId(station: string, existing: Mission[]): string {
  const prefix = stationPrefix(station);
  const taken = new Set(existing.map((mission) => mission.id));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 7).padEnd(5, "0");
    const id = `${prefix}-${suffix}`;
    if (!taken.has(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36).slice(-5)}`;
}

export interface FileMissionInput {
  station: string;
  title: string;
  intent: string;
  acceptance?: string[];
  verify?: string;
  branch?: string;
  severity?: MissionSeverity;
  parent?: string;
  lane?: string;
  dependsOn?: string[];
}

/** File a new mission in `open` state. */
export function fileMission(input: FileMissionInput, metaDir?: string): Mission {
  return withLedgerLock(input.station, metaDir, () => {
    const existing = readMissions(input.station, metaDir);
    const now = new Date().toISOString();
    const mission: Mission = {
      id: nextMissionId(input.station, existing),
      title: input.title.trim(),
      intent: input.intent.trim(),
      status: "open",
      acceptance: input.acceptance?.filter((line) => line.trim()) ?? [],
      verify: input.verify?.trim() || undefined,
      station: input.station,
      branch: input.branch,
      severity: input.severity ?? "normal",
      parent: input.parent,
      lane: input.lane?.trim() || undefined,
      dependsOn: input.dependsOn?.filter((id) => id.trim()) ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    appendRecord(input.station, mission, metaDir);
    return mission;
  });
}

export type MissionPatch = Partial<
  Pick<
    Mission,
    | "title"
    | "intent"
    | "status"
    | "acceptance"
    | "verify"
    | "branch"
    | "claimedBy"
    | "blockedReason"
    | "severity"
    | "parent"
    | "evidence"
  >
>;

export interface MissionUpdateResult {
  mission: Mission | null;
  error?: string;
}

export function updateMission(
  station: string,
  id: string,
  patch: MissionPatch,
  metaDir?: string,
): MissionUpdateResult {
  return withLedgerLock(station, metaDir, () => {
    const current = readMissions(station, metaDir).find((mission) => mission.id === id);
    if (!current) return { mission: null, error: `Mission ${id} not found on station ${station}` };

    if (patch.status && !canTransition(current.status, patch.status)) {
      return {
        mission: current,
        error: `Cannot move mission ${id} from ${current.status} to ${patch.status}`,
      };
    }

    const next: Mission = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (patch.status === "landed") next.landedAt = next.updatedAt;
    if (patch.status === "open") {
      next.claimedBy = undefined;
      next.claimedAt = undefined;
    }

    appendRecord(station, next, metaDir);
    return { mission: next };
  });
}

/**
 * Claim the next open mission for a coder.
 *
 * The claim lock is what makes parallel coders safe: today `parallelWorkers`
 * defaults to 1 because every worker reads the same goal string and collides on
 * the same files.
 */
export function claimNextMission(
  station: string,
  workerId: string,
  metaDir?: string,
): Mission | null {
  return withLedgerLock(station, metaDir, () => {
    const missions = readMissions(station, metaDir);

    // A coder that died mid-mission keeps its claim; hand it back on reconnect.
    const resumable = missions.find(
      // `verified` is deliberately excluded: that work is done and waiting on a
      // merge, so handing it back would put the coder straight into a loop
      // re-doing finished work.
      (mission) =>
        mission.claimedBy === workerId &&
        (mission.status === "claimed" || mission.status === "active"),
    );
    if (resumable) return resumable;

    const landed = new Set(missions.filter((m) => m.status === "landed").map((m) => m.id));

    // Lanes another coder is holding right now. Without this two workers pull
    // adjacent missions from the same subsystem, build the same feature twice in
    // separate worktrees, and every merge after the first one conflicts.
    const lanesHeldByOthers = new Set(
      missions
        .filter(
          (m) =>
            IN_FLIGHT.includes(m.status) &&
            m.claimedBy != null &&
            m.claimedBy !== workerId &&
            m.lane != null,
        )
        .map((m) => m.lane as string),
    );

    const bySeverity = (mission: Mission) =>
      mission.severity === "high" ? 0 : mission.severity === "low" ? 2 : 1;
    const open = missions
      .filter((mission) => mission.status === "open")
      // A mission whose prerequisites have not landed would be built against a
      // worktree that cannot see them. Leave it open rather than start it blind.
      .filter((mission) => (mission.dependsOn ?? []).every((id) => landed.has(id)))
      .filter((mission) => mission.lane == null || !lanesHeldByOthers.has(mission.lane))
      .sort((a, b) => bySeverity(a) - bySeverity(b) || a.createdAt.localeCompare(b.createdAt));

    const target = open[0];
    if (!target) return null;

    const now = new Date().toISOString();
    const claimed: Mission = {
      ...target,
      status: "claimed",
      claimedBy: workerId,
      claimedAt: now,
      updatedAt: now,
      blockedReason: undefined,
    };
    appendRecord(station, claimed, metaDir);
    return claimed;
  });
}

export function blockMission(
  station: string,
  id: string,
  reason: string,
  metaDir?: string,
): MissionUpdateResult {
  return updateMission(station, id, { status: "blocked", blockedReason: reason }, metaDir);
}

/**
 * Land a verified mission.
 *
 * Evidence is the gate, not the agent's word — the same principle the tick-report
 * ground truth already enforces. A mission without a commit and a passing verify
 * run stays open.
 */
/**
 * Records verified evidence without declaring the mission landed.
 *
 * A coder can only prove things about its own worktree. Whether that work
 * reached the base branch is the watcher's observation, not the coder's — a
 * mission that lands on the strength of a local commit reports success for work
 * that may be sitting on a branch whose merge failed.
 */
export function verifyMission(
  station: string,
  id: string,
  evidence: MissionEvidence,
  metaDir?: string,
): MissionUpdateResult {
  const problems: string[] = [];
  if (!evidence.commits?.length && !evidence.verifyOnly) problems.push("no commits recorded");
  if (!evidence.tests?.passed) problems.push("verify command did not pass");
  if (problems.length) {
    return {
      mission: getMission(station, id, metaDir),
      error: `Cannot verify ${id}: ${problems.join("; ")}`,
    };
  }

  return updateMission(station, id, { status: "verified", evidence }, metaDir);
}

/** Promotes verified work to landed once it is merged into the base branch. */
export function landVerifiedMission(
  station: string,
  id: string,
  metaDir?: string,
): MissionUpdateResult {
  const mission = getMission(station, id, metaDir);
  if (!mission) return { mission: null, error: `Unknown mission ${id}` };
  if (mission.status === "landed") return { mission };
  if (mission.status !== "verified") {
    return { mission, error: `Cannot land ${id} from status ${mission.status}` };
  }
  return updateMission(station, id, { status: "landed" }, metaDir);
}

export function landMission(
  station: string,
  id: string,
  evidence: MissionEvidence,
  metaDir?: string,
): MissionUpdateResult {
  const problems: string[] = [];
  if (!evidence.commits?.length && !evidence.verifyOnly) problems.push("no commits recorded");
  if (!evidence.tests?.passed) problems.push("verify command did not pass");
  if (problems.length) {
    return {
      mission: getMission(station, id, metaDir),
      error: `Cannot land ${id}: ${problems.join("; ")}`,
    };
  }

  const verified = updateMission(station, id, { status: "verified", evidence }, metaDir);
  if (verified.error) return verified;
  return updateMission(station, id, { status: "landed", evidence }, metaDir);
}

export function summarizeStation(station: string, metaDir?: string): MissionSummary {
  const missions = readMissions(station, metaDir);
  const count = (status: MissionStatus) => missions.filter((m) => m.status === status).length;

  const active =
    missions.find((mission) => mission.status === "active") ??
    missions.find((mission) => mission.status === "claimed") ??
    missions.find((mission) => mission.status === "verified") ??
    null;

  const next = missions.find((mission) => mission.status === "open") ?? null;
  const inFlight = missions.filter((mission) => IN_FLIGHT.includes(mission.status)).length;

  return {
    station,
    total: missions.filter((mission) => mission.status !== "dropped").length,
    open: count("open"),
    inFlight,
    landed: count("landed"),
    blocked: count("blocked"),
    dropped: count("dropped"),
    active,
    next,
    drained: count("open") === 0 && inFlight === 0,
  };
}

/** List stations that have a ledger on disk. */
export function listStations(metaDir?: string): string[] {
  const root = orbitDir(metaDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(missionsPath(name, metaDir)));
  } catch {
    return [];
  }
}

/** Compact prompt block describing the coder's current assignment. */
export function formatMissionForPrompt(mission: Mission | null): string {
  if (!mission) {
    return "No mission assigned. Do not invent work — report idle and exit.";
  }

  const lines = [
    `Mission ${mission.id}: ${mission.title}`,
    `Why: ${mission.intent}`,
  ];
  if (mission.acceptance.length) {
    lines.push("Acceptance criteria:");
    for (const item of mission.acceptance) lines.push(`- ${item}`);
  }
  if (mission.verify) lines.push(`Verify with: ${mission.verify}`);
  lines.push(
    "Stay on this mission until every acceptance criterion holds and verify passes. Do not start unrelated work.",
  );
  return lines.join("\n");
}
