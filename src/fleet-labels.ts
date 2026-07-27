/** Human-readable labels for fleet experiments and SDK runs (dashboard + summaries). */

const SUPERVISOR_LABELS: Record<string, string> = {
  "strategy-review-loop": "Strategy critic",
  "watch-experiments": "Fleet watcher",
  "orchestrator-loop": "Pulse orchestrator",
};

export function friendlyExperimentName(raw: string): string {
  const mapped = SUPERVISOR_LABELS[raw];
  if (mapped) return mapped;

  const sdk = /^sdk-worker-(\d+)$/.exec(raw);
  if (sdk) return `Self-improve worker #${sdk[1]}`;
  if (raw === "sdk-worker-main") return "Self-improve worker";

  if (raw === "worker-dedicated") return "Dedicated IDE worker";
  const ideSession = /^worker-session-(\d+)$/.exec(raw);
  if (ideSession) return `IDE worker #${ideSession[1]}`;
  const ide = /^worker-(\d+)$/.exec(raw);
  if (ide) return `IDE worker #${ide[1]}`;

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
