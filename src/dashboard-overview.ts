import type { WorkerActivityBreakdown, WorkerTickBreakdown } from "./dashboard-activity.js";
import type { DashboardSnapshot, FleetProductivitySummary } from "./dashboard.js";
import type { MissionSummary } from "./orbit-ledger.js";

export interface FleetOverview {
  headline: string;
  paragraph: string;
  status: "ok" | "warn" | "bad" | "idle";
}

function cleanText(text?: string): string {
  return (text ?? "").replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function explainWorkerError(error: string): string {
  if (/SDK run rate/i.test(error)) {
    return "Progress is paused because the hourly SDK run cap was reached — this is an API budget limit, not a code failure. Wait for the rolling window to clear or raise CURSOR_META_MAX_SDK_RUNS_PER_HOUR.";
  }
  if (/ground[- ]truth|tick report/i.test(error)) {
    return "The last checkpoint was rejected because the worker's tick report did not match verified git/test state — it needs to re-run verify and report honestly.";
  }
  if (/transport|connection|timeout|dropped/i.test(error)) {
    return `Why progress stalled: the agent session lost its connection (${error}) — the worker will retry on the next checkpoint.`;
  }
  if (/batch (commit|push)/i.test(error)) {
    return "The supervisor blocked a commit or push that would have spammed CI or split work into tiny standalone commits.";
  }
  return error;
}

/**
 * The why, preferring the ledger over the launch goal.
 *
 * A manifest goal is a static launch string that never retires; a mission states
 * the reason for the work actually in flight right now.
 */
function missionWhy(
  manifest: DashboardSnapshot["manifest"],
  missions?: MissionSummary | null,
): string | undefined {
  const active = missions?.active ?? missions?.next;
  const intent = cleanText(active?.intent);
  if (intent) return truncate(intent, 220);

  const goal = manifest?.goal?.trim();
  if (!goal) return undefined;
  return truncate(goal, 220);
}

/** Ledger progress, e.g. `3 of 5 missions landed`. */
function missionProgress(missions?: MissionSummary | null): string | undefined {
  if (!missions || missions.total === 0) return undefined;
  const parts = [`${missions.landed} of ${missions.total} missions landed`];
  if (missions.blocked > 0) {
    parts.push(`${missions.blocked} blocked`);
  }
  return parts.join(", ");
}

function strategyIssues(status: DashboardSnapshot["strategyStatus"]): string[] {
  if (!status || !Array.isArray(status.issues)) return [];
  return status.issues.map((issue) => cleanText(String(issue))).filter(Boolean);
}

function whyHeadline(input: {
  manifest: DashboardSnapshot["manifest"];
  strategyStatus: DashboardSnapshot["strategyStatus"];
  sdkWorker?: WorkerActivityBreakdown;
  status: FleetOverview["status"];
  missions?: MissionSummary | null;
}): string {
  const { manifest, strategyStatus, sdkWorker, status, missions } = input;
  const pivot = cleanText(typeof strategyStatus?.pivot === "string" ? strategyStatus.pivot : "");
  const recommendation = cleanText(
    typeof strategyStatus?.recommendation === "string" ? strategyStatus.recommendation : "",
  );
  const err = cleanText(sdkWorker?.statusText);
  const latestErr = cleanText(sdkWorker?.recentTicks[0]?.error);

  if (manifest?.budgetBlocked) return "Paused — budget limit reached";
  if (sdkWorker?.status === "error" || latestErr) {
    if (/SDK run rate/i.test(err || latestErr)) return "Blocked — hourly SDK run cap";
    return "Blocked — worker error";
  }

  // A drained queue is the completion signal a duration-driven fleet never had.
  if (missions && missions.total > 0 && missions.drained) {
    return truncate(`All missions landed — ${missionProgress(missions)}`, 100);
  }

  const activeMission = missions?.active;
  if (activeMission) {
    return truncate(`${activeMission.id}: ${cleanText(activeMission.title)}`, 100);
  }

  if (pivot) return truncate(pivot, 100);
  if (recommendation) return truncate(recommendation.split(/[.!?]/)[0] ?? recommendation, 100);
  if (sdkWorker?.status === "active") {
    const mission = missionWhy(manifest, missions);
    if (mission) return truncate(`Working on: ${mission}`, 100);
    return "Deep slice in progress";
  }
  if (status === "warn") return "Fleet needs attention";
  if (status === "idle") return "Fleet idle";
  return "Fleet running";
}

function whyParagraph(input: {
  manifest: DashboardSnapshot["manifest"];
  strategyStatus: DashboardSnapshot["strategyStatus"];
  sdkWorker?: WorkerActivityBreakdown;
  productivity: FleetProductivitySummary | null;
  missions?: MissionSummary | null;
}): string {
  const { manifest, strategyStatus, sdkWorker, productivity, missions } = input;
  const parts: string[] = [];

  const mission = missionWhy(manifest, missions);
  if (mission) parts.push(`Why we're here: ${mission}`);

  if (missions && missions.total > 0) {
    const progress = missionProgress(missions);
    if (missions.drained) {
      parts.push(
        `Why nothing is queued: ${progress} and no mission remains open — file the next mission or retire the coder.`,
      );
    } else if (progress) {
      parts.push(`Where we stand: ${progress}, ${missions.open} still open.`);
    }
  }

  const onTrack = strategyStatus?.onTrack === true;
  const score = typeof strategyStatus?.score === "number" ? strategyStatus.score : undefined;
  const issues = strategyIssues(strategyStatus);
  const recommendation = cleanText(
    typeof strategyStatus?.recommendation === "string" ? strategyStatus.recommendation : "",
  );
  const pivot = cleanText(typeof strategyStatus?.pivot === "string" ? strategyStatus.pivot : "");

  if (issues.length > 0) {
    const lead = issues.slice(0, 2).join(" ");
    parts.push(onTrack ? `Why to watch: ${lead}` : `Why we're off track: ${lead}`);
  } else if (onTrack && score != null) {
    parts.push(`Why this looks healthy: strategy score ${score}/100 and no open issues flagged.`);
  }

  if (pivot) {
    parts.push(`Why next: ${pivot.replace(/[.!?]+$/, "")}.`);
  } else if (recommendation) {
    parts.push(`Why next: ${recommendation.replace(/[.!?]+$/, "")}.`);
  }

  const workerErr = cleanText(
    sdkWorker?.recentTicks[0]?.error ??
      (sdkWorker?.status === "error" ? sdkWorker?.statusText : ""),
  );
  if (sdkWorker?.status === "error" || (workerErr && sdkWorker?.recentTicks[0]?.error)) {
    parts.push(explainWorkerError(workerErr));
  }

  if (
    productivity &&
    productivity.attemptedTicks >= 3 &&
    !productivity.meetsGate &&
    !workerErr
  ) {
    parts.push(
      `Why productivity matters: only ${productivity.productiveTicks} of ${productivity.attemptedTicks} checkpoints produced verified progress — the fleet won't scale until more slices actually land.`,
    );
  }

  return parts.join(" ");
}

export function buildFleetOverview(input: {
  fleetHealth: DashboardSnapshot["fleetHealth"];
  manifest: DashboardSnapshot["manifest"];
  strategyStatus: DashboardSnapshot["strategyStatus"];
  workerActivity: WorkerActivityBreakdown[];
  productivity: FleetProductivitySummary | null;
  missions?: MissionSummary | null;
}): FleetOverview {
  const { fleetHealth: fh, manifest, strategyStatus, workerActivity, productivity, missions } = input;
  const sdkWorker = workerActivity.find((row) => row.name.startsWith("sdk-worker"));

  if (manifest?.budgetBlocked) {
    const reason = manifest.budgetBlockedReason ?? "budget supervisor halt";
    return {
      status: "bad",
      headline: "Paused — budget limit",
      paragraph: `Why work stopped: autonomous runs are blocked (${reason}). Relaunch after the budget window resets or limits are raised.`,
    };
  }

  if (!fh.total) {
    const why = missionWhy(manifest, missions);
    return {
      status: "idle",
      headline: "Fleet idle",
      paragraph: why
        ? `Why nothing is running: no workers are active. Mission when launched: ${why}`
        : "Why nothing is running: no workers are active. Launch the fleet to start autonomous work.",
    };
  }

  if (fh.alive === 0) {
    const sdk = workerActivity.find((row) => row.name.startsWith("sdk-worker"));
    const lastSession = sdk?.statusText?.startsWith("Last session:") ? sdk.statusText : null;
    return {
      status: lastSession ? "idle" : "bad",
      headline: lastSession ? "Session finished" : "Fleet stopped",
      paragraph: lastSession
        ? `Why it stopped: ${lastSession}. Run preflight before the next launch.`
        : "Why it stopped: all worker processes exited. Check logs for the underlying reason.",
    };
  }

  const status: FleetOverview["status"] =
    fh.alive < fh.total ? "warn" : sdkWorker?.status === "error" ? "bad" : "ok";

  return {
    status,
    headline: whyHeadline({ manifest, strategyStatus, sdkWorker, status, missions }),
    paragraph: whyParagraph({ manifest, strategyStatus, sdkWorker, productivity, missions }),
  };
}

/** @deprecated internal test helper — kept for tests that assert shipped tick formatting */
export function humanShippedTick(tick: WorkerTickBreakdown): string {
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
