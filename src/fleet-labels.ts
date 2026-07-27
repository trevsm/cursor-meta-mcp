/** Human-readable labels for fleet experiments and SDK runs (dashboard + summaries). */

const SUPERVISOR_NAMES = new Set([
  "strategy-review-loop",
  "watch-experiments",
  "orchestrator-loop",
]);

const SUPERVISOR_LABELS: Record<string, string> = {
  "strategy-review-loop": "Strategy critic",
  "watch-experiments": "Fleet watcher",
  "orchestrator-loop": "Pulse orchestrator",
};

export type FleetRoleKind = "coder" | "supervisor";

export function fleetRoleKind(experimentName: string): FleetRoleKind {
  if (SUPERVISOR_NAMES.has(experimentName)) return "supervisor";
  return "coder";
}

function isCoderExperiment(name: string): boolean {
  if (name.startsWith("sdk-worker")) return true;
  if (name === "worker-dedicated") return true;
  if (/^worker-session-\d+$/.test(name)) return true;
  if (/^worker-\d+$/.test(name)) return true;
  return false;
}

export function computeFleetRoleCounts(input: {
  experiments: Array<{ name: string; alive: boolean }>;
  watcherAlive: boolean;
}): {
  codersTotal: number;
  codersAlive: number;
  supervisorsTotal: number;
  supervisorsAlive: number;
} {
  let codersTotal = 0;
  let codersAlive = 0;
  let supervisorsTotal = 0;
  let supervisorsAlive = 0;

  for (const exp of input.experiments) {
    if (fleetRoleKind(exp.name) === "supervisor") {
      supervisorsTotal++;
      if (exp.alive) supervisorsAlive++;
    } else if (isCoderExperiment(exp.name)) {
      codersTotal++;
      if (exp.alive) codersAlive++;
    }
  }

  const includeWatcher = input.experiments.length > 0 || input.watcherAlive;
  if (includeWatcher) {
    supervisorsTotal++;
    if (input.watcherAlive) supervisorsAlive++;
  }

  return { codersTotal, codersAlive, supervisorsTotal, supervisorsAlive };
}

export const FLEET_WORKER_ROLE_DESCRIPTIONS: Record<string, string> = {
  "strategy-review-loop": "Reviews fleet health every 5 minutes",
  "watch-experiments": "Patrols workers, budget, and relaunch gates",
  "orchestrator-loop": "Pulse orchestrator for IDE sessions",
};

export function fleetWorkerRoleDescription(experimentName: string): string {
  const mapped = FLEET_WORKER_ROLE_DESCRIPTIONS[experimentName];
  if (mapped) return mapped;
  if (experimentName.startsWith("sdk-worker")) {
    return "Ships verified diffs: test → commit → push";
  }
  if (experimentName === "worker-dedicated") {
    return "Dedicated IDE coding session";
  }
  if (/^worker-session-\d+$/.test(experimentName) || /^worker-\d+$/.test(experimentName)) {
    return "IDE coding session";
  }
  return "Fleet supervisor";
}

export function friendlyExperimentName(raw: string): string {
  const mapped = SUPERVISOR_LABELS[raw];
  if (mapped) return mapped;

  const sdk = /^sdk-worker-(\d+)$/.exec(raw);
  if (sdk) return `Coder #${sdk[1]}`;
  if (raw === "sdk-worker-main") return "Coder";

  if (raw === "worker-dedicated") return "Dedicated IDE coder";
  const ideSession = /^worker-session-(\d+)$/.exec(raw);
  if (ideSession) return `IDE coder #${ideSession[1]}`;
  const ide = /^worker-(\d+)$/.exec(raw);
  if (ide) return `IDE coder #${ide[1]}`;

  return raw
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function friendlySdkAgentLabel(params: {
  agentName?: string;
  workerExperiment?: string;
  tick?: number;
  agentId?: string;
}): string {
  const worker = params.workerExperiment
    ? friendlyExperimentName(params.workerExperiment)
    : params.agentName
      ? humanizeSlug(params.agentName)
      : "Fleet SDK agent";

  if (params.tick != null && params.tick > 0) {
    return `${worker} · tick ${params.tick}`;
  }

  if (params.agentName && !params.workerExperiment) {
    return humanizeSlug(params.agentName);
  }

  if (params.agentId) {
    return `${worker} (${shortId(params.agentId)})`;
  }

  return worker;
}

export function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function shortId(id: string): string {
  const trimmed = id.replace(/^agent-/, "");
  return trimmed.slice(0, 8);
}

export function friendlyEpisodeActor(
  actor: string | undefined,
  agentIndex?: Map<string, { workerName: string; tick?: number; agentName?: string }>,
): string | undefined {
  if (!actor) return undefined;
  if (actor === "sdk-worker") return "Coder";
  if (actor.startsWith("agent-")) {
    const ctx = agentIndex?.get(actor);
    if (ctx) {
      return friendlySdkAgentLabel({
        agentName: ctx.agentName,
        workerExperiment: ctx.workerName,
        tick: ctx.tick,
      });
    }
    return friendlySdkAgentLabel({ agentName: "self-improve-fleet", agentId: actor });
  }
  return actor;
}

/** Map SDK agentId → owning worker experiment + latest tick (from checkpoints). */
export function indexWorkerAgents(
  experiments: Array<{
    name: string;
    agentId?: string;
    checkpoint?: { ticks?: number; lastTick?: { tick?: number; agentId?: string } | null };
  }>,
): Map<string, { workerName: string; tick?: number; agentName?: string }> {
  const byAgent = new Map<string, { workerName: string; tick?: number; agentName?: string }>();
  for (const exp of experiments) {
    if (!exp.name.startsWith("sdk-worker")) continue;
    const cp = exp.checkpoint;
    const last = cp?.lastTick;
    const agentId = exp.agentId ?? last?.agentId;
    if (!agentId) continue;
    byAgent.set(agentId, {
      workerName: exp.name,
      tick: last?.tick ?? cp?.ticks,
      agentName: "self-improve-fleet",
    });
  }
  return byAgent;
}
