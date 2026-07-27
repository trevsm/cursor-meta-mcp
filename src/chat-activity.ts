import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { getSessionIndexForId, listChatSummaries, type ChatSummary } from "./history-store.js";

export type ChatActivityLevel = "active" | "recent" | "idle";

export interface ChatActivity {
  sessionIndex?: number;
  sessionId: string;
  title: string;
  workspace: string;
  updatedAt: string;
  activityLevel: ChatActivityLevel;
  composerStatus?: string;
  generatingBubbleCount: number;
  loadingToolCount: number;
  hasBlockingPendingActions: boolean;
  latestBubbleAt?: string;
  signals: string[];
}

export interface ListActiveChatsArgs {
  limit?: number;
  workspace?: string;
  withinMs?: number;
  includeIdle?: boolean;
}

function globalDbPath(): string {
  return process.env.CURSOR_META_STATE_DB ?? join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function openGlobalDb(readonly: boolean): Database.Database {
  return new Database(globalDbPath(), { readonly, fileMustExist: true });
}

function parseHeaderValue(raw: string) {
  return JSON.parse(raw) as {
    name?: string;
    hasBlockingPendingActions?: boolean;
  };
}

function parseComposerData(raw: string | null | undefined) {
  if (!raw) return undefined;
  return JSON.parse(raw) as {
    status?: string;
    generatingBubbleIds?: string[];
  };
}

const LOADING_TOOL_STATUSES = new Set(["loading", "running", "started", "pending"]);

function inspectBubble(value: string, cutoffMs: number) {
  try {
    const bubble = JSON.parse(value) as {
      createdAt?: string;
      toolFormerData?: { status?: string; name?: string };
    };
    const createdAtMs = bubble.createdAt ? Date.parse(bubble.createdAt) : undefined;
    if (createdAtMs != null && createdAtMs < cutoffMs) {
      return { latestAt: createdAtMs, loading: false };
    }
    const status = bubble.toolFormerData?.status;
    return {
      latestAt: createdAtMs,
      loading: status != null && LOADING_TOOL_STATUSES.has(status),
    };
  } catch {
    return { latestAt: undefined, loading: false };
  }
}

export function getChatActivity(sessionId: string, summary?: ChatSummary): ChatActivity {
  const db = openGlobalDb(true);
  try {
    const headerRow = db
      .prepare("SELECT value, lastUpdatedAt FROM composerHeaders WHERE composerId = ?")
      .get(sessionId) as { value?: string; lastUpdatedAt?: number } | undefined;

    if (!headerRow?.value) {
      throw new Error(`Chat session ${sessionId} not found.`);
    }

    const header = parseHeaderValue(headerRow.value);
    const composerRow = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${sessionId}`) as { value?: string } | undefined;
    const composerData = parseComposerData(composerRow?.value);

    const cutoffMs = Date.now() - 2 * 60 * 1000;
    const bubbles = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid DESC LIMIT 40")
      .all(`bubbleId:${sessionId}:%`) as Array<{ value: string }>;

    let loadingToolCount = 0;
    let latestBubbleAt: string | undefined;
    for (const bubble of bubbles) {
      const parsed = inspectBubble(bubble.value, cutoffMs);
      if (parsed.loading) loadingToolCount += 1;
      if (parsed.latestAt != null) {
        const iso = new Date(parsed.latestAt).toISOString();
        if (!latestBubbleAt || iso > latestBubbleAt) latestBubbleAt = iso;
      }
    }

    const generatingBubbleCount = composerData?.generatingBubbleIds?.length ?? 0;
    const composerStatus = composerData?.status;
    const hasBlockingPendingActions = Boolean(header.hasBlockingPendingActions);
    const updatedAt = new Date(headerRow.lastUpdatedAt ?? Date.now()).toISOString();

    const signals: string[] = [];
    if (generatingBubbleCount > 0) signals.push("generating_bubbles");
    if (loadingToolCount > 0) signals.push("loading_tools");
    if (hasBlockingPendingActions) signals.push("blocking_pending_actions");
    if (composerStatus && !["none", "completed", "aborted"].includes(composerStatus)) {
      signals.push(`composer_status:${composerStatus}`);
    }

    const activityLevel: ChatActivityLevel =
      signals.length > 0 ? "active" : Date.now() - Date.parse(updatedAt) <= 5 * 60 * 1000 ? "recent" : "idle";

    return {
      sessionIndex: summary?.sessionIndex ?? getSessionIndexForId(sessionId),
      sessionId,
      title: summary?.title ?? header.name ?? "(untitled)",
      workspace: summary?.workspace ?? "unknown",
      updatedAt,
      activityLevel,
      composerStatus,
      generatingBubbleCount,
      loadingToolCount,
      hasBlockingPendingActions,
      latestBubbleAt,
      signals,
    };
  } finally {
    db.close();
  }
}

export function getChatActivityByIndex(sessionIndex: number): ChatActivity {
  const page = listChatSummaries({ limit: 1, offset: sessionIndex - 1 });
  const summary = page.sessions[0];
  if (!summary) {
    throw new Error(`Session #${sessionIndex} not found (${page.total} sessions available).`);
  }
  return getChatActivity(summary.id, summary);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until a freshly created chat appears in Cursor's SQLite storage. */
export async function waitForChatSession(
  sessionId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      getChatActivity(sessionId);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("not found")) {
        throw error;
      }
    }
    await sleep(pollMs);
  }

  throw new Error(`Chat session ${sessionId} not found after ${timeoutMs}ms.`);
}

export function listActiveChats(args: ListActiveChatsArgs = {}): ChatActivity[] {
  const withinMs = args.withinMs ?? 5 * 60 * 1000;
  const limit = args.limit ?? 20;
  const summaries = listChatSummaries({ limit: 100, offset: 0, workspace: args.workspace }).sessions;

  const activities: ChatActivity[] = [];
  for (const summary of summaries) {
    const activity = getChatActivity(summary.id, summary);
    const isRecent = Date.now() - Date.parse(activity.updatedAt) <= withinMs;
    if (activity.activityLevel === "active" || isRecent || args.includeIdle) {
      activities.push(activity);
    }
    if (activities.length >= limit) break;
  }

  return activities;
}

export function abortIdeChatInStorage(sessionId: string): { aborted: boolean; previousStatus?: string } {
  const db = openGlobalDb(false);
  try {
    const row = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${sessionId}`) as { value?: string } | undefined;

    if (!row?.value) {
      return { aborted: false };
    }

    const data = JSON.parse(row.value) as {
      status?: string;
      generatingBubbleIds?: string[];
    };
    const previousStatus = data.status;
    data.status = "aborted";
    data.generatingBubbleIds = [];

    db.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(
      JSON.stringify(data),
      `composerData:${sessionId}`,
    );

    return { aborted: true, previousStatus };
  } finally {
    db.close();
  }
}
