import type { WorkerActivityBreakdown, WorkerTickBreakdown } from "./dashboard-activity.js";
import type { DashboardSnapshot, FleetProductivitySummary } from "./dashboard.js";

export interface FleetOverview {
  headline: string;
  paragraph: string;
  status: "ok" | "warn" | "bad" | "idle";
}

function cleanText(text?: string): string {
  return (text ?? "").replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function isRawStreamStatus(text: string): boolean {
  return /^(tool |thinking…?|status |assistant|error)/i.test(text);
}

function humanActiveStatus(worker: WorkerActivityBreakdown): string {
  const live = cleanText(worker.statusText);
  if (!live || isRawStreamStatus(live)) {
    return `running tick ${(worker.ticksCompleted ?? 0) + 1}`;
  }
  return live.charAt(0).toLowerCase() + live.slice(1);
}

function humanShippedTick(tick: WorkerTickBreakdown): string {
  const parts: string[] = [];
  if (tick.commits) parts.push(`${tick.commits} commit${tick.commits === 1 ? "" : "s"}`);
  if (tick.filesChanged) {
    parts.push(`${tick.filesChanged} file${tick.filesChanged === 1 ? "" : "s"} changed`);
  }
  if (tick.testsPassed && tick.testTotal) {
    parts.push(`all ${tick.testTotal} tests passed`);
  } else if (tick.testsPassed) {
    parts.push("tests passed");
  }
  const detail = parts.length ? parts.join(", ") : "verified changes";
  const work = cleanText(tick.workSummary);
  if (work) return `Tick ${tick.tick} shipped ${detail} — ${work}`;
  return `Tick ${tick.tick} shipped ${detail}.`;
}

function headlineForWorker(worker: WorkerActivityBreakdown): string | undefined {
  const latest = worker.recentTicks[0];
  if (worker.status === "active") {
    if (isRawStreamStatus(cleanText(worker.statusText))) {
      return `${worker.displayName} · tick ${(worker.ticksCompleted ?? 0) + 1} in progress`;
    }
    const live = cleanText(worker.statusText);
    if (/^tick \d+/i.test(live)) return live.slice(0, 100);
    if (live) return live.slice(0, 100);
    return `${worker.displayName} · tick ${(worker.ticksCompleted ?? 0) + 1} in progress`;
  }
  if (worker.status === "error") {
    return `${worker.displayName} hit an error`;
  }
  if (latest?.producedWork) {
    const bits: string[] = [`Tick ${latest.tick} shipped`];
    if (latest.commits) bits.push(`${latest.commits} commit${latest.commits === 1 ? "" : "s"}`);
    if (latest.testsPassed && latest.testTotal) bits.push(`${latest.testTotal} tests passed`);
    return bits.join(" · ");
  }
  if (worker.ticksCompleted) {
    return `${worker.displayName} idle after tick ${worker.ticksCompleted}`;
  }
  return undefined;
}

export function buildFleetOverview(input: {
  fleetHealth: DashboardSnapshot["fleetHealth"];
  manifest: DashboardSnapshot["manifest"];
  strategyStatus: DashboardSnapshot["strategyStatus"];
  workerActivity: WorkerActivityBreakdown[];
  productivity: FleetProductivitySummary | null;
}): FleetOverview {
  const { fleetHealth: fh, manifest, strategyStatus, workerActivity, productivity } = input;
  const sdkWorker = workerActivity.find((row) => row.name.startsWith("sdk-worker"));
  const strategy = workerActivity.find((row) => row.name === "strategy-review-loop");
  const sentences: string[] = [];

  if (manifest?.budgetBlocked) {
    const reason = manifest.budgetBlockedReason ?? "budget supervisor halt";
    return {
      status: "bad",
      headline: "Fleet paused — budget limit",
      paragraph: `Autonomous work is blocked (${reason}). Relaunch after budget resets or limits are adjusted.`,
    };
  }

  if (!fh.total) {
    return {
      status: "idle",
      headline: "Fleet is idle",
      paragraph: "No workers are running. Relaunch the fleet to start the self-improve loop.",
    };
  }

  if (fh.alive === 0) {
    const sdk = workerActivity.find((row) => row.name.startsWith("sdk-worker"));
    const lastSession = sdk?.statusText?.startsWith("Last session:") ? sdk.statusText : null;
    return {
      // An archived session is a graceful finish; anything else means the
      // fleet died with work outstanding.
      status: lastSession ? "idle" : "bad",
      headline: lastSession ? "Fleet stopped — session archived" : "Fleet stopped",
      paragraph: lastSession
        ? `${sdk?.displayName ?? "Worker"}: ${lastSession} Run npm run fleet:preflight before the next launch.`
        : `All ${fh.total} worker processes have stopped. Check logs and relaunch when ready.`,
    };
  }

  const status: FleetOverview["status"] =
    fh.alive < fh.total ? "warn" : sdkWorker?.status === "error" ? "bad" : "ok";

  if (fh.alive === fh.total) {
    sentences.push(
      fh.total === 1
        ? "The fleet worker is up and healthy."
        : `All ${fh.total} fleet workers are up and healthy.`,
    );
  } else {
    sentences.push(`Fleet is degraded — ${fh.alive} of ${fh.total} workers are alive.`);
  }

  if (sdkWorker) {
    if (sdkWorker.status === "active") {
      sentences.push(`${sdkWorker.displayName} is ${humanActiveStatus(sdkWorker)}.`);
    } else if (sdkWorker.status === "error") {
      sentences.push(`${sdkWorker.displayName} failed: ${cleanText(sdkWorker.statusText)}.`);
    } else if (sdkWorker.ticksCompleted) {
      sentences.push(`${sdkWorker.displayName} is idle between ticks (${sdkWorker.ticksCompleted} completed).`);
    }

    const latest = sdkWorker.recentTicks.find((tick) => tick.producedWork) ?? sdkWorker.recentTicks[0];
    if (latest?.producedWork) {
      sentences.push(`Latest work: ${humanShippedTick(latest)}`);
    } else if (latest?.error) {
      sentences.push(`Latest tick failed: ${cleanText(latest.error)}.`);
    }
  }

  if (productivity && productivity.attemptedTicks > 0) {
    const pct = (productivity.productiveRatio * 100).toFixed(0);
    if (productivity.meetsGate) {
      sentences.push(
        `${productivity.productiveTicks} of ${productivity.attemptedTicks} attempted ticks produced verified diffs (${pct}%).`,
      );
    } else {
      sentences.push(
        `Only ${productivity.productiveTicks} of ${productivity.attemptedTicks} attempted ticks were productive (${pct}%, below the ${productivity.gatePercent}% gate).`,
      );
    }
  }

  const recommendation =
    typeof strategyStatus?.recommendation === "string" ? cleanText(strategyStatus.recommendation) : "";
  if (recommendation) {
    const critic = strategy?.displayName ?? "Strategy critic";
    const rec = recommendation.replace(/[.!?]+$/, "");
    sentences.push(`${critic}: ${rec}.`);
  }

  const headline =
    headlineForWorker(sdkWorker ?? workerActivity[0] ?? { displayName: "Fleet", name: "", alive: false, role: "", status: "idle", statusText: "", ticksCompleted: 0, recentTicks: [], liveEvents: [] }) ??
    (status === "warn" ? "Fleet needs attention" : "Fleet running smoothly");

  return {
    status,
    headline,
    paragraph: sentences.join(" "),
  };
}
