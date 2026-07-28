import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_AGI_ARCHITECTURE,
  mergeAgiArchitecture,
  SUPERVISOR_LAYERS_FROZEN,
  type AgiAdaptationRecord,
  type AgiArchitecture,
} from "./agi-architecture.js";
import {
  buildAgiWorkerPrompt,
  launchAgiMission,
  readActiveAgiSession,
  type ActiveAgiSession,
  writeActiveAgiSession,
} from "./agi-mission.js";
import { projectMetaDir, resolveProjectRoot } from "./project-meta.js";
import {
  idempotencyKeyForAction,
  requestHumanApproval,
  requiresHumanApproval,
  resolveHumanApproval,
  type HumanApprovalRequest,
} from "./human-gate.js";
import type { FleetLauncher, SelfImproveManifest } from "./self-improve.js";
import {
  blockMission,
  fileMission,
  readMissions,
  stationId,
  summarizeStation,
} from "./orbit-ledger.js";

export interface StrategyStatusSnapshot {
  at?: string;
  onTrack?: boolean;
  score?: number;
  issues?: string[];
  recommendation?: string;
  pivot?: string | null;
  kill?: number[];
  killExperiments?: string[];
}

export interface WatchStatusSnapshot {
  at?: string;
  relaunchBlocked?: boolean;
  relaunchBlockedReason?: string;
  supervisor?: { shouldKill?: boolean; reasons?: string[] };
}

/** Turn a strategy pivot into durable Orbit work instead of another prompt string. */
export function applyOrbitMissionPivot(
  session: ActiveAgiSession,
  pivot: string,
): { blockedMissionId?: string; missionId: string } | null {
  const intent = pivot.trim();
  if (!intent) return null;

  const station = stationId(session.cwd);
  const metaDir = session.projectMetaDir;
  const existing = readMissions(station, metaDir);
  const duplicate = existing.find(
    (mission) =>
      mission.intent.trim().toLowerCase() === intent.toLowerCase() &&
      ["open", "claimed", "active", "verified"].includes(mission.status),
  );
  if (duplicate) return { missionId: duplicate.id };

  const current = summarizeStation(station, metaDir).active;
  let blockedMissionId: string | undefined;
  if (current) {
    const blocked = blockMission(
      station,
      current.id,
      `Superseded by AGI mission pivot: ${intent}`,
      metaDir,
    );
    if (!blocked.error) blockedMissionId = current.id;
  }

  const mission = fileMission(
    {
      station,
      title: intent.length > 80 ? `${intent.slice(0, 77)}…` : intent,
      intent,
      acceptance: ["Implement the pivot without unrelated scope", "Local verify passes"],
      verify: current?.verify,
      branch: current?.branch,
      severity: "high",
      parent: current?.parent,
    },
    metaDir,
  );
  return { blockedMissionId, missionId: mission.id };
}

export interface AgiSnagReport {
  at: string;
  cwd: string;
  onTrack: boolean | null;
  score: number | null;
  issues: string[];
  recommendation: string | null;
  pivot: string | null;
  infraSignals: string[];
}

export interface AgiAdaptationProposal {
  id: string;
  layer: AgiAdaptationRecord["layer"];
  trigger: string;
  summary: string;
  architecture?: Partial<AgiArchitecture>;
  missionPivot?: string;
  metaToolingHint?: string;
  priority: number;
}

export interface AgiAdaptParams {
  auto?: boolean;
  reason?: string;
  architecture?: Partial<AgiArchitecture>;
  missionPivot?: string;
  relaunch?: boolean;
  proposalIds?: string[];
  /** Resolved approval id when strict human gate blocked relaunch. */
  approvalId?: string;
}

export interface AgiAdaptResult {
  ok: true;
  diagnosed: AgiSnagReport;
  proposals: AgiAdaptationProposal[];
  applied: AgiAdaptationProposal[];
  session: ActiveAgiSession;
  manifest?: SelfImproveManifest;
  relaunched: boolean;
  adaptationBudgetRemaining: number;
  pendingApproval?: HumanApprovalRequest;
}

function readJsonSafe<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function adaptationsPath(cwd: string): string {
  return join(projectMetaDir(cwd), "adaptations.json");
}

export function loadAdaptationHistory(cwd: string): AgiAdaptationRecord[] {
  return readJsonSafe<{ records?: AgiAdaptationRecord[] }>(adaptationsPath(cwd))?.records ?? [];
}

export function appendAdaptationRecord(cwd: string, record: AgiAdaptationRecord): void {
  const path = adaptationsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const records = loadAdaptationHistory(cwd);
  records.push(record);
  writeFileSync(path, JSON.stringify({ records }, null, 2));
}

export function adaptationsInLastHour(cwd: string, now = Date.now()): number {
  const cutoff = now - 60 * 60_000;
  return loadAdaptationHistory(cwd).filter((row) => Date.parse(row.at) >= cutoff).length;
}

export function sessionArchitecture(session: ActiveAgiSession | null): AgiArchitecture {
  return mergeAgiArchitecture(DEFAULT_AGI_ARCHITECTURE, session?.architecture);
}

export function diagnoseAgiSnags(session: ActiveAgiSession): AgiSnagReport {
  const strategy = readJsonSafe<StrategyStatusSnapshot>(
    join(session.experimentsDir, "strategy-status.json"),
  );
  const watch = readJsonSafe<WatchStatusSnapshot>(join(session.experimentsDir, "watch-status.json"));
  const auth = readJsonSafe<{ sdk?: boolean; apiKey?: boolean; note?: string }>(
    join(session.experimentsDir, "worker-auth.json"),
  );

  const infraSignals: string[] = [];
  if (watch?.relaunchBlocked) {
    infraSignals.push(watch.relaunchBlockedReason ?? "watcher_relaunch_blocked");
  }
  if (watch?.supervisor?.shouldKill) {
    infraSignals.push(...(watch.supervisor.reasons ?? ["budget_supervisor_kill"]));
  }
  if (auth && !auth.sdk && !auth.apiKey) {
    infraSignals.push("worker_auth_missing");
  } else if (auth && !auth.sdk) {
    infraSignals.push("sdk_unavailable");
  }

  return {
    at: new Date().toISOString(),
    cwd: session.cwd,
    onTrack: strategy?.onTrack ?? null,
    score: strategy?.score ?? null,
    issues: strategy?.issues ?? [],
    recommendation: strategy?.recommendation ?? null,
    pivot: strategy?.pivot ?? null,
    infraSignals,
  };
}

export function proposeAgiAdaptations(
  session: ActiveAgiSession,
  diagnosed: AgiSnagReport,
  architecture: AgiArchitecture,
): AgiAdaptationProposal[] {
  const proposals: AgiAdaptationProposal[] = [];
  const issues = new Set(diagnosed.issues);
  const infra = new Set(diagnosed.infraSignals);

  if (issues.has("meta_discussion_loop") || issues.has("architecture_theater")) {
    if (architecture.withOrchestrator) {
      proposals.push({
        id: "disable_orchestrator",
        layer: "orchestration",
        trigger: [...issues].filter((i) => i.includes("meta") || i.includes("architecture")).join(","),
        summary: "Disable pulse orchestrator — it is amplifying meta loops.",
        architecture: { withOrchestrator: false },
        priority: 90,
      });
    }
  }

  if (issues.has("fragmented_parallel_tabs") && architecture.parallelWorkers > 1) {
    proposals.push({
      id: "reduce_parallelism",
      layer: "worker",
      trigger: "fragmented_parallel_tabs",
      summary: "Reduce parallel workers to one focused executor.",
      architecture: { parallelWorkers: 1, workerMode: "sdk" },
      priority: 85,
    });
  }

  if (
    issues.has("stale_workers") ||
    issues.has("repeated_failure") ||
    infra.has("worker_auth_missing") ||
    infra.has("sdk_unavailable")
  ) {
    if (architecture.workerMode === "sdk") {
      proposals.push({
        id: "fallback_ide_worker",
        layer: "worker",
        trigger: [...issues, ...infra].join(","),
        summary: "Fallback from SDK to IDE worker — auth or repeated execution failures.",
        architecture: { workerMode: "ide", parallelWorkers: 0 },
        priority: 95,
      });
    }
    proposals.push({
      id: "accelerate_strategy_review",
      layer: "orchestration",
      trigger: "stale_workers,repeated_failure",
      summary: "Review strategy twice as often while recovering.",
      architecture: { strategyReviewIntervalMs: Math.max(60_000, architecture.strategyReviewIntervalMs / 2) },
      priority: 70,
    });
  }

  if (issues.has("no_code_progress")) {
    proposals.push({
      id: "narrow_mission_step",
      layer: "mission",
      trigger: "no_code_progress",
      summary: "Decompose mission into one concrete next file change.",
      missionPivot:
        diagnosed.pivot ??
        "Pick the smallest shippable slice of the mission: one file, one test, one commit.",
      priority: 80,
    });
  }

  if (diagnosed.pivot && !proposals.some((p) => p.missionPivot)) {
    proposals.push({
      id: "apply_strategy_pivot",
      layer: "mission",
      trigger: "strategy_pivot",
      summary: "Apply strategy reviewer pivot to worker prompt.",
      missionPivot: diagnosed.pivot,
      priority: 75,
    });
  }

  if (infra.has("watcher_relaunch_blocked") || infra.has("budget_supervisor_kill")) {
    proposals.push({
      id: "meta_tooling_budget",
      layer: "meta_tooling",
      trigger: infra.has("budget_supervisor_kill") ? "budget_supervisor_kill" : "watcher_relaunch_blocked",
      summary: "Conductor inspects budget supervisor / watcher — patch fleet infra if misconfigured.",
      metaToolingHint:
        "Check meta_plan_budget, dashboard supervisor banner, and cursor-meta-mcp watcher paths for this project's meta dir.",
      priority: 88,
    });
  }

  if (
    architecture.allowMetaToolingChanges &&
    (infra.has("worker_auth_missing") || issues.has("stale_workers"))
  ) {
    proposals.push({
      id: "meta_tooling_auth",
      layer: "meta_tooling",
      trigger: "worker_auth",
      summary: "Conductor may patch worker-auth / load-env / preflight in cursor-meta-mcp when auth path is wrong.",
      metaToolingHint: "Run fleet preflight; verify ~/.cursor/.env CURSOR_API_KEY and worker-auth.json.",
      priority: 82,
    });
  }

  return proposals.sort((a, b) => b.priority - a.priority);
}

function buildMissionPrompt(session: ActiveAgiSession, pivot?: string): string {
  const base = buildAgiWorkerPrompt(session.task);
  const archNote = [
    "",
    "Meta-adaptation: when the same approach fails twice, change decomposition, verification, or tooling.",
    "You may adjust how you work (not just retry). Prefer a different small step over repeating errors.",
  ].join("\n");
  if (!pivot?.trim()) return `${base}${archNote}`;
  return `${base}${archNote}\n\n[Strategy pivot] ${pivot.trim()}`;
}

function pickProposals(
  all: AgiAdaptationProposal[],
  params: AgiAdaptParams,
): AgiAdaptationProposal[] {
  if (params.proposalIds?.length) {
    const wanted = new Set(params.proposalIds);
    return all.filter((p) => wanted.has(p.id));
  }
  if (params.architecture || params.missionPivot || params.reason) {
    return [
      {
        id: "manual",
        layer: params.architecture ? "orchestration" : "mission",
        trigger: params.reason ?? "manual",
        summary: params.reason ?? "Manual architecture adjustment",
        architecture: params.architecture,
        missionPivot: params.missionPivot,
        priority: 100,
      },
    ];
  }
  if (params.auto === false) return [];
  return all.slice(0, 2);
}

export async function adaptAgiMission(
  params: AgiAdaptParams = {},
  launch?: FleetLauncher,
): Promise<AgiAdaptResult> {
  const session = readActiveAgiSession();
  if (!session) {
    throw new Error("No active AGI session. Start with meta_agi first.");
  }

  const architecture = sessionArchitecture(session);
  const diagnosed = diagnoseAgiSnags(session);
  if (params.reason) {
    diagnosed.issues = [...new Set([...diagnosed.issues, params.reason])];
  }

  const allProposals = proposeAgiAdaptations(session, diagnosed, architecture);
  const manualOverride =
    Boolean(params.architecture) ||
    Boolean(params.missionPivot?.trim()) ||
    Boolean(params.proposalIds?.length) ||
    Boolean(params.reason?.trim());
  if (SUPERVISOR_LAYERS_FROZEN && params.auto !== false && !manualOverride) {
    return {
      ok: true,
      diagnosed,
      proposals: allProposals,
      applied: [],
      session,
      relaunched: false,
      adaptationBudgetRemaining: Math.max(
        0,
        architecture.maxAdaptationsPerHour - adaptationsInLastHour(session.cwd),
      ),
    };
  }
  const toApply = pickProposals(allProposals, params);

  const adaptationsThisHour = adaptationsInLastHour(session.cwd);
  const budgetRemaining = Math.max(0, architecture.maxAdaptationsPerHour - adaptationsThisHour);
  if (toApply.length > 0 && budgetRemaining <= 0) {
    throw new Error(
      `Adaptation budget exhausted (${architecture.maxAdaptationsPerHour}/hour). Wait or raise maxAdaptationsPerHour.`,
    );
  }

  const nextArchitecture = mergeAgiArchitecture(architecture, {});
  let missionPivot: string | undefined;
  const applied: AgiAdaptationProposal[] = [];

  for (const proposal of toApply) {
    if (proposal.architecture) {
      Object.assign(nextArchitecture, mergeAgiArchitecture(nextArchitecture, proposal.architecture));
    }
    if (proposal.missionPivot) {
      missionPivot = missionPivot
        ? `${missionPivot}\n${proposal.missionPivot}`
        : proposal.missionPivot;
    }
    applied.push(proposal);
    appendAdaptationRecord(session.cwd, {
      at: new Date().toISOString(),
      trigger: proposal.trigger,
      layer: proposal.layer,
      summary: proposal.summary,
      before: architecture,
      after: proposal.architecture ?? {},
      missionPivot: proposal.missionPivot,
    });
  }

  if (params.architecture) {
    Object.assign(nextArchitecture, mergeAgiArchitecture(nextArchitecture, params.architecture));
  }
  if (params.missionPivot?.trim()) {
    const manualPivot = params.missionPivot.trim();
    if (!missionPivot) missionPivot = manualPivot;
    else if (missionPivot !== manualPivot) missionPivot = `${missionPivot}\n${manualPivot}`;
  }

  const updatedSession: ActiveAgiSession = {
    ...session,
    architecture: nextArchitecture,
  };
  writeActiveAgiSession(updatedSession);

  if (missionPivot?.trim()) {
    applyOrbitMissionPivot(updatedSession, missionPivot);
  }

  const relaunch = params.relaunch ?? true;
  let manifest: SelfImproveManifest | undefined;

  const metaToolingOnly =
    applied.length > 0 && applied.every((p) => p.layer === "meta_tooling" && !p.architecture);

  if (relaunch && !metaToolingOnly && (applied.length > 0 || params.architecture || params.missionPivot)) {
    const archSummary = JSON.stringify(nextArchitecture);
    const gate = requiresHumanApproval(archSummary, nextArchitecture.humanGateMode);
    if (gate.required) {
      if (!params.approvalId) {
        const pending = requestHumanApproval({
          action: gate.action,
          question: `Approve AGI architecture change (${gate.risk})?`,
          context: applied.map((p) => p.summary).join("; ") || archSummary.slice(0, 500),
          urgency: gate.risk === "critical" ? "high" : "medium",
          sessionId: updatedSession.sessionId,
          runId: updatedSession.runId,
          cwd: updatedSession.cwd,
          idempotencyKey: idempotencyKeyForAction(`adapt:${gate.action}`, updatedSession.sessionId),
        });
        return {
          ok: true,
          diagnosed,
          proposals: allProposals,
          applied,
          session: updatedSession,
          relaunched: false,
          adaptationBudgetRemaining: Math.max(0, budgetRemaining - applied.length),
          pendingApproval: pending,
        };
      }
      const resolved = resolveHumanApproval({ id: params.approvalId, approved: true });
      if (!resolved.approved) {
        throw new Error(`Adaptation blocked: approval ${params.approvalId} was denied.`);
      }
    }

    const prompt = buildMissionPrompt(updatedSession, missionPivot);
    const result = await launchAgiMission(
      {
        cwd: resolveProjectRoot(session.cwd),
        task: session.task,
        excludeSessionIndex: 1,
        architecture: nextArchitecture,
        prompt,
        stopExisting: true,
        freshStart: false,
        resumeWorkers: false,
      },
      launch,
    );
    manifest = result.manifest;
    writeActiveAgiSession({ ...updatedSession, ...result.session, architecture: nextArchitecture });
  }

  return {
    ok: true,
    diagnosed,
    proposals: allProposals,
    applied,
    session: readActiveAgiSession() ?? updatedSession,
    manifest,
    relaunched: Boolean(manifest),
    adaptationBudgetRemaining: Math.max(0, budgetRemaining - applied.length),
  };
}
