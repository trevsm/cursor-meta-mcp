import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { getSessionIndexForId } from "./history-store.js";
import {
  isMetaDiscussion,
  isOrchestrationExempt,
  isRepeatedFailureLoop,
  isTerseRejection,
  isTerseStill,
} from "./meta-discussion.js";

export { isMetaDiscussion } from "./meta-discussion.js";

export type OrchestrationAction = "WATCH" | "INTERCEPT" | "CONTINUE" | "SPAWN_SPECIALIST";

export interface PulseBubble {
  type: "user" | "assistant";
  text: string;
  tool?: string;
}

export interface FrustrationRisk {
  score: number;
  reason: string | null;
}

export interface OrchestrationPlay {
  action: OrchestrationAction;
  tool: string;
  why: string;
  prompt?: string;
}

export interface PulseSessionEntry {
  sessionId: string;
  sessionIndex?: number;
  title: string;
  workspace: string;
  signals: string[];
  frustrationRisk: FrustrationRisk;
  lastBubble?: string;
  orchestrationExempt?: boolean;
}

export interface PulseParallelWorkspace {
  workspace: string;
  concurrentSessions: number;
  titles: string[];
}

export interface ConsciousnessPulseParams {
  limit?: number;
  workspace?: string;
}

export interface ConsciousnessPulseReport {
  at: string;
  scanned: number;
  live: PulseSessionEntry[];
  frustrationEvents: PulseSessionEntry[];
  orchestrationMatrix: Array<PulseSessionEntry & { plays: OrchestrationPlay[] }>;
  parallelWorkspaces: PulseParallelWorkspace[];
}

const FRUSTRATION_AFTER_DONE =
  /\b(still not working|still broken|doesn't work|bad\. no\.|maybe we just can)\b/i;
const AGENT_CLAIMED_DONE =
  /\b(fixed|done|complete|deployed|should work|ready|resolved|success)\b/i;
const PUSHBACK_AFTER_DONE =
  /\b(still not working|still broken|still wrong|still getting|didn't work|not working|not right|that's wrong|this is wrong)\b/i;

function globalDbFile(): string {
  const override = process.env.CURSOR_META_STATE_DB;
  if (override) return override;
  return join(homedir(), "Library", "Application Support/Cursor", "User", "globalStorage", "state.vscdb");
}

export function activitySignalsFromComposer(
  composer: { status?: string; generatingBubbleIds?: string[] } | null | undefined,
  bubbles: PulseBubble[],
): string[] {
  const signals: string[] = [];
  if ((composer?.generatingBubbleIds?.length ?? 0) > 0) signals.push("generating");
  if (composer?.status && !["none", "completed", "aborted"].includes(composer.status)) {
    signals.push(`status:${composer.status}`);
  }
  const loading = bubbles.filter((bubble) => bubble.tool).length;
  if (loading > 0) signals.push(`loading_tools:${loading}`);
  return signals;
}


export function frustrationRiskFromBubbles(bubbles: PulseBubble[]): FrustrationRisk {
  const lastUser = [...bubbles].reverse().find((bubble) => bubble.type === "user");
  const lastAsst = [...bubbles].reverse().find((bubble) => bubble.type === "assistant");
  if (!lastUser) return { score: 0, reason: null };

  const userText = lastUser.text.trim();
  if (isMetaDiscussion(userText)) {
    return { score: 0, reason: null };
  }

  if (FRUSTRATION_AFTER_DONE.test(userText)) {
    return { score: 0.95, reason: "post_failure_rejection" };
  }
  if (isRepeatedFailureLoop(userText)) {
    return { score: 0.9, reason: "repeated_failure_loop" };
  }
  if (
    lastAsst &&
    AGENT_CLAIMED_DONE.test(lastAsst.text.slice(-500)) &&
    PUSHBACK_AFTER_DONE.test(userText)
  ) {
    return { score: 0.85, reason: "false_completion_response" };
  }
  if (isTerseStill(userText)) {
    return { score: 0.92, reason: "terse_still" };
  }
  if (isTerseRejection(userText)) {
    return { score: 0.88, reason: "terse_rejection" };
  }

  return { score: 0, reason: null };
}

/** Detect when an idle assistant is waiting on the user instead of continuing. */
export function assistantOfferedHandoff(text: string): boolean {
  const tail = text.slice(-800);
  const trimmedTail = tail.trim();
  if (
    /\b(want me to|would you like|should i|shall i|let me know|next step|what would you like|which (one|option)|pick one|your call|awaiting (your )?(input|direction))\b/i.test(
      tail,
    )
  ) {
    return true;
  }
  return (
    /\?\s*$/.test(trimmedTail) &&
    /\b(i can|i could|options?|prefer|choose|continue|proceed|also)\b/i.test(tail)
  );
}

export function orchestrationPlays(
  title: string,
  workspace: string,
  signals: string[],
  risk: FrustrationRisk,
  bubbles: PulseBubble[],
): OrchestrationPlay[] {
  const plays: OrchestrationPlay[] = [];

  if (signals.includes("generating") || signals.some((signal) => signal.startsWith("loading_tools"))) {
    plays.push({
      action: "WATCH",
      tool: "meta_watch_chat",
      why: "In-flight generation — poll until idle before steering",
    });
  }

  if (risk.score >= 0.8 && risk.reason !== null) {
    const interceptPrompt =
      risk.reason === "repeated_failure_loop"
        ? "Stop. You are looping on the same failure. Diff your last change against the actual error, abandon the repeating approach, and fix the root cause with a verified alternative."
        : "Stop. The last approach failed. Re-read the actual error state, verify before claiming done, then fix root cause only.";
    plays.push({
      action: "INTERCEPT",
      tool: "meta_intercept_chat",
      why: `Frustration event (${risk.reason}) — abort false path, inject corrective steer`,
      prompt: interceptPrompt,
    });
  }

  if (signals.length === 0 && risk.score < 0.3) {
    const lastUser = [...bubbles].reverse().find((bubble) => bubble.type === "user");
    if (isOrchestrationExempt(lastUser?.text ?? "", title)) {
      return plays;
    }
    const lastAsst = [...bubbles].reverse().find((bubble) => bubble.type === "assistant");
    if (lastAsst && assistantOfferedHandoff(lastAsst.text)) {
      plays.push({
        action: "CONTINUE",
        tool: "meta_watch_chat",
        why: "Agent paused for user direction while idle — auto-continue highest-value branch",
        prompt:
          "Do not ask the user. Pick the highest-value next step and execute it. Verify with tests when code changes.",
      });
    }
  }

  if (workspace.includes("faciliq") && signals.length > 0 && !isOrchestrationExempt("", title)) {
    plays.push({
      action: "SPAWN_SPECIALIST",
      tool: "meta_spawn_local_agent",
      why: "Parallel headless verifier while IDE chat runs — cross-check without blocking UI",
      prompt: `Verify the changes in "${title}" independently. Run tests, read diffs, report blockers only.`,
    });
  }

  if (isOrchestrationExempt("", title)) {
    return plays.filter((play) => play.action === "WATCH");
  }

  return plays;
}

function parseRecentBubbles(rawRows: Array<{ value: string }>, limit = 8): PulseBubble[] {
  const bubbles: PulseBubble[] = [];
  for (const row of rawRows.slice(0, limit)) {
    try {
      const bubble = JSON.parse(row.value) as {
        type?: number;
        text?: string;
        toolFormerData?: { status?: string; name?: string };
      };
      const parsed: PulseBubble = {
        type: bubble.type === 2 ? "assistant" : "user",
        text: (bubble.text ?? "").slice(0, 400),
      };
      if (bubble.toolFormerData?.status === "loading" && bubble.toolFormerData.name) {
        parsed.tool = bubble.toolFormerData.name;
      }
      bubbles.push(parsed);
    } catch {
      continue;
    }
  }
  return bubbles.reverse();
}

export function runConsciousnessPulse(params: ConsciousnessPulseParams = {}): ConsciousnessPulseReport {
  const limit = params.limit ?? 25;
  const db = new Database(globalDbFile(), { readonly: true, fileMustExist: true });

  try {
    const sessions = db
      .prepare(
        `SELECT composerId, value
         FROM composerHeaders
         WHERE IFNULL(isSubagent, 0) = 0
         ORDER BY lastUpdatedAt DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ composerId: string; value: string }>;

    const pulse: ConsciousnessPulseReport = {
      at: new Date().toISOString(),
      scanned: sessions.length,
      live: [],
      frustrationEvents: [],
      orchestrationMatrix: [],
      parallelWorkspaces: [],
    };

    const byWorkspace = new Map<string, string[]>();

    for (const row of sessions) {
      const header = JSON.parse(row.value) as {
        name?: string;
        workspaceIdentifier?: { uri?: { fsPath?: string; path?: string }; id?: string };
      };
      const workspace =
        header.workspaceIdentifier?.uri?.fsPath ??
        header.workspaceIdentifier?.uri?.path ??
        header.workspaceIdentifier?.id ??
        "unknown";
      const title = header.name ?? "(untitled)";

      if (params.workspace && !workspace.includes(params.workspace)) continue;

      if (!byWorkspace.has(workspace)) byWorkspace.set(workspace, []);
      byWorkspace.get(workspace)!.push(title);

      const composerRow = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${row.composerId}`) as { value?: string } | undefined;
      const composer = composerRow?.value
        ? (JSON.parse(composerRow.value) as { status?: string; generatingBubbleIds?: string[] })
        : null;

      const bubbleRows = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid DESC LIMIT ?")
        .all(`bubbleId:${row.composerId}:%`, 8) as Array<{ value: string }>;
      const bubbles = parseRecentBubbles(bubbleRows);
      const signals = activitySignalsFromComposer(composer, bubbles);
      const risk = frustrationRiskFromBubbles(bubbles);
      const lastUser = [...bubbles].reverse().find((bubble) => bubble.type === "user");

      const entry: PulseSessionEntry = {
        sessionId: row.composerId,
        sessionIndex: getSessionIndexForId(row.composerId),
        title,
        workspace,
        signals,
        frustrationRisk: risk,
        lastBubble: bubbles.at(-1)?.text?.slice(0, 120),
        orchestrationExempt: isOrchestrationExempt(lastUser?.text ?? "", title),
      };

      if (signals.length > 0) pulse.live.push(entry);
      else if (risk.score >= 0.7) pulse.frustrationEvents.push(entry);

      const plays = orchestrationPlays(title, workspace, signals, risk, bubbles);
      if (plays.length > 0) {
        pulse.orchestrationMatrix.push({ ...entry, plays });
      }
    }

    pulse.parallelWorkspaces = [...byWorkspace.entries()]
      .filter(([, titles]) => titles.length >= 2 && titles[0] !== "empty-window")
      .map(([workspace, titles]) => ({
        workspace,
        concurrentSessions: titles.length,
        titles: titles.slice(0, 4),
      }));

    return pulse;
  } finally {
    db.close();
  }
}
