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

function missionWhy(manifest: DashboardSnapshot["manifest"]): string | undefined {
  const goal = manifest?.goal?.trim();
  if (!goal) return undefined;
  return truncate(goal, 220);
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
}): string {
  const { manifest, strategyStatus, sdkWorker, status } = input;
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
  if (pivot) return truncate(pivot, 100);
  if (recommendation) return truncate(recommendation.split(/[.!?]/)[0] ?? recommendation, 100);
  if (sdkWorker?.status === "active") {
    const mission = missionWhy(manifest);
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
}): string {
  const { manifest, strategyStatus, sdkWorker, productivity } = input;
  const parts: string[] = [];

  const mission = missionWhy(manifest);
  if (mission) parts.push(`Why we're here: ${mission}`);

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
}): FleetOverview {
  const { fleetHealth: fh, manifest, strategyStatus, workerActivity, productivity } = input;
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
    return {
      status: "idle",
      headline: "Fleet idle",
      paragraph: missionWhy(manifest)
        ? `Why nothing is running: no workers are active. Mission when launched: ${missionWhy(manifest)}`
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
    headline: whyHeadline({ manifest, strategyStatus, sdkWorker, status }),
    paragraph: whyParagraph({ manifest, strategyStatus, sdkWorker, productivity }),
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
