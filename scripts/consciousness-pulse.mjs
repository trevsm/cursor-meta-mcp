#!/usr/bin/env node
/**
 * Consciousness Pulse — live orchestration scan over Cursor's internal state.
 * Combines chat activity signals, frustration-risk heuristics, and cross-session patterns.
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const DB =
  process.env.CURSOR_META_STATE_DB ??
  join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");

const FRUSTRATION_AFTER_DONE =
  /\b(still not working|still broken|doesn't work|bad\. no\.|^still\.?$|maybe we just can)\b/i;
const AGENT_CLAIMED_DONE =
  /\b(fixed|done|complete|deployed|should work|ready|resolved|success)\b/i;

function openDb() {
  return new Database(DB, { readonly: true, fileMustExist: true });
}

function listRecentSessions(db, limit = 30) {
  return db
    .prepare(
      `SELECT composerId, lastUpdatedAt, value
       FROM composerHeaders
       WHERE IFNULL(isSubagent, 0) = 0
       ORDER BY lastUpdatedAt DESC
       LIMIT ?`,
    )
    .all(limit);
}

function getComposer(db, id) {
  const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${id}`);
  return row?.value ? JSON.parse(row.value) : null;
}

function getRecentBubbles(db, id, limit = 8) {
  return db
    .prepare(
      "SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid DESC LIMIT ?",
    )
    .all(`bubbleId:${id}:%`, limit)
    .map((r) => {
      try {
        const b = JSON.parse(r.value);
        return {
          type: b.type === 2 ? "assistant" : "user",
          text: (b.text ?? "").slice(0, 400),
          tool: b.toolFormerData?.status === "loading" ? b.toolFormerData?.name : undefined,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function activitySignals(composer, bubbles) {
  const signals = [];
  if ((composer?.generatingBubbleIds?.length ?? 0) > 0) signals.push("generating");
  if (composer?.status && !["none", "completed", "aborted"].includes(composer.status)) {
    signals.push(`status:${composer.status}`);
  }
  const loading = bubbles.filter((b) => b.tool).length;
  if (loading > 0) signals.push(`loading_tools:${loading}`);
  return signals;
}

function frustrationRisk(bubbles) {
  const lastUser = [...bubbles].reverse().find((b) => b.type === "user");
  const lastAsst = [...bubbles].reverse().find((b) => b.type === "assistant");
  if (!lastUser) return { score: 0, reason: null };

  let score = 0;
  let reason = null;

  if (FRUSTRATION_AFTER_DONE.test(lastUser.text)) {
    score = 0.95;
    reason = "post_failure_rejection";
  } else if (lastAsst && AGENT_CLAIMED_DONE.test(lastAsst.text) && /\b(still|but|wrong|not)\b/i.test(lastUser.text)) {
    score = 0.85;
    reason = "false_completion_response";
  } else if (/^still\.?$/i.test(lastUser.text.trim())) {
    score = 0.92;
    reason = "terse_still";
  }

  return { score, reason };
}

function orchestrationPlay(composerId, title, workspace, signals, risk, bubbles) {
  const plays = [];

  if (signals.includes("generating") || signals.some((s) => s.startsWith("loading_tools"))) {
    plays.push({
      action: "WATCH",
      tool: "meta_get_chat_activity",
      why: "In-flight generation — poll until idle before steering",
    });
  }

  if (risk.score >= 0.8) {
    plays.push({
      action: "INTERCEPT",
      tool: "meta_intercept_chat",
      why: `Frustration event (${risk.reason}) — abort false path, inject corrective steer`,
      prompt: "Stop. The last approach failed. Re-read the actual error state, verify before claiming done, then fix root cause only.",
    });
  }

  if (signals.length === 0 && risk.score < 0.3) {
    const lastAsst = [...bubbles].reverse().find((b) => b.type === "assistant");
    if (lastAsst?.text.includes("Want me to") || lastAsst?.text.includes("Next step")) {
      plays.push({
        action: "CONTINUE",
        tool: "meta_send_to_chat",
        why: "Agent offered next steps but session went idle — auto-continue highest-value branch",
        prompt: "Execute the most valuable next step you proposed. Do not re-explain.",
      });
    }
  }

  if (workspace.includes("faciliq") && signals.length > 0) {
    plays.push({
      action: "SPAWN_SPECIALIST",
      tool: "meta_spawn_local_agent",
      why: "Parallel headless verifier while IDE chat runs — cross-check without blocking UI",
      prompt: `Verify the changes in "${title}" independently. Run tests, read diffs, report blockers only.`,
    });
  }

  return plays;
}

const db = openDb();
const sessions = listRecentSessions(db, 25);
const pulse = {
  at: new Date().toISOString(),
  db: DB,
  scanned: sessions.length,
  live: [],
  idleWithOpportunity: [],
  frustrationEvents: [],
  orchestrationMatrix: [],
};

for (const row of sessions) {
  const header = JSON.parse(row.value);
  const composer = getComposer(db, row.composerId);
  const bubbles = getRecentBubbles(db, row.composerId);
  const signals = activitySignals(composer, bubbles);
  const risk = frustrationRisk(bubbles);
  const workspace = header.workspaceIdentifier?.uri?.fsPath ?? "unknown";
  const title = header.name ?? "(untitled)";

  const entry = {
    sessionId: row.composerId,
    title,
    workspace,
    signals,
    frustrationRisk: risk,
    lastBubble: bubbles.at(-1)?.text?.slice(0, 120),
  };

  if (signals.length > 0) pulse.live.push(entry);
  else if (entry.frustrationRisk.score >= 0.7) pulse.frustrationEvents.push(entry);

  const plays = orchestrationPlay(row.composerId, title, workspace, signals, risk, bubbles);
  if (plays.length > 0) {
    pulse.orchestrationMatrix.push({ ...entry, plays });
  }
}

// Cross-session: same workspace, multiple recent sessions today
const byWs = new Map();
for (const row of sessions) {
  const h = JSON.parse(row.value);
  const ws = h.workspaceIdentifier?.uri?.fsPath ?? "unknown";
  if (!byWs.has(ws)) byWs.set(ws, []);
  byWs.get(ws).push(h.name ?? "(untitled)");
}
pulse.parallelWorkspaces = [...byWs.entries()]
  .filter(([, titles]) => titles.length >= 2 && titles[0] !== "empty-window")
  .map(([workspace, titles]) => ({ workspace, concurrentSessions: titles.length, titles: titles.slice(0, 4) }));

db.close();
console.log(JSON.stringify(pulse, null, 2));
