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
  /** Cap header rows scanned (defaults to max(limit * 4, 40)). */
  maxScan?: number;
}

export interface GetChatActivityOptions {
  /** Scan recent bubbles for loading-tool signals (default: auto). */
  scanBubbles?: boolean;
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
    workspaceIdentifier?: {
      id?: string;
      uri?: { fsPath?: string; path?: string };
    };
  };
}

function workspaceFromHeader(header: ReturnType<typeof parseHeaderValue>): string {
  const uri = header.workspaceIdentifier?.uri;
  return uri?.fsPath ?? uri?.path ?? header.workspaceIdentifier?.id ?? "unknown";
}

function parseComposerData(raw: string | null | undefined) {
  if (!raw) return undefined;
  return JSON.parse(raw) as {
    status?: string;
    generatingBubbleIds?: string[];
  };
}

const LOADING_TOOL_STATUSES = new Set(["loading", "running", "started", "pending"]);
const IDLE_COMPOSER_STATUSES = new Set(["none", "completed", "aborted"]);

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

function shouldScanBubbles(
  composerData: ReturnType<typeof parseComposerData>,
  header: ReturnType<typeof parseHeaderValue>,
): boolean {
  if (header.hasBlockingPendingActions) return true;
  if ((composerData?.generatingBubbleIds?.length ?? 0) > 0) return true;
  const status = composerData?.status;
  if (status && !IDLE_COMPOSER_STATUSES.has(status)) return true;
  return false;
}

function bubbleKeyRange(sessionId: string): { start: string; end: string } {
  const start = `bubbleId:${sessionId}:`;
  const end = `${start.slice(0, -1)};`;
  return { start, end };
}

function scanBubbleActivity(
  db: Database.Database,
  sessionId: string,
  cutoffMs: number,
): { loadingToolCount: number; latestBubbleAt?: string } {
  const { start, end } = bubbleKeyRange(sessionId);
  const bubbles = db
    .prepare(
      `SELECT value FROM cursorDiskKV
       WHERE key >= ? AND key < ?
       ORDER BY rowid DESC
       LIMIT 40`,
    )
    .all(start, end) as Array<{ value: string }>;

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

  return { loadingToolCount, latestBubbleAt };
}

function buildChatActivity(
  sessionId: string,
  header: ReturnType<typeof parseHeaderValue>,
  lastUpdatedAt: number,
  composerData: ReturnType<typeof parseComposerData>,
  bubbleActivity: { loadingToolCount: number; latestBubbleAt?: string },
  summary?: ChatSummary,
): ChatActivity {
  const generatingBubbleCount = composerData?.generatingBubbleIds?.length ?? 0;
  const composerStatus = composerData?.status;
  const hasBlockingPendingActions = Boolean(header.hasBlockingPendingActions);
  const updatedAt = new Date(lastUpdatedAt).toISOString();

  const signals: string[] = [];
  if (generatingBubbleCount > 0) signals.push("generating_bubbles");
  if (bubbleActivity.loadingToolCount > 0) signals.push("loading_tools");
  if (hasBlockingPendingActions) signals.push("blocking_pending_actions");
  if (composerStatus && !IDLE_COMPOSER_STATUSES.has(composerStatus)) {
    signals.push(`composer_status:${composerStatus}`);
  }

  const activityLevel: ChatActivityLevel =
    signals.length > 0 ? "active" : Date.now() - Date.parse(updatedAt) <= 5 * 60 * 1000 ? "recent" : "idle";

  return {
    sessionIndex: summary?.sessionIndex,
    sessionId,
    title: summary?.title ?? header.name ?? "(untitled)",
    workspace: summary?.workspace ?? workspaceFromHeader(header),
    updatedAt,
    activityLevel,
    composerStatus,
    generatingBubbleCount,
    loadingToolCount: bubbleActivity.loadingToolCount,
    hasBlockingPendingActions,
    latestBubbleAt: bubbleActivity.latestBubbleAt,
    signals,
  };
}

function loadComposerActivity(
  db: Database.Database,
  sessionId: string,
  headerValue: string,
  lastUpdatedAt: number,
  summary: ChatSummary | undefined,
  options: GetChatActivityOptions,
): ChatActivity {
  const header = parseHeaderValue(headerValue);
  const composerRow = db
    .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
    .get(`composerData:${sessionId}`) as { value?: string } | undefined;
  const composerData = parseComposerData(composerRow?.value);

  const scanBubbles =
    options.scanBubbles ?? shouldScanBubbles(composerData, header);
  const bubbleActivity = scanBubbles
    ? scanBubbleActivity(db, sessionId, Date.now() - 2 * 60 * 1000)
    : { loadingToolCount: 0, latestBubbleAt: undefined };

  return buildChatActivity(sessionId, header, lastUpdatedAt, composerData, bubbleActivity, summary);
}

export function getChatActivity(
  sessionId: string,
  summary?: ChatSummary,
  options: GetChatActivityOptions = {},
): ChatActivity {
  const db = openGlobalDb(true);
  try {
    const headerRow = db
      .prepare("SELECT value, lastUpdatedAt FROM composerHeaders WHERE composerId = ?")
      .get(sessionId) as { value?: string; lastUpdatedAt?: number } | undefined;

    if (!headerRow?.value) {
      throw new Error(`Chat session ${sessionId} not found.`);
    }

    return withSessionIndex(
      loadComposerActivity(
        db,
        sessionId,
        headerRow.value,
        headerRow.lastUpdatedAt ?? Date.now(),
        summary,
        options,
      ),
    );
  } finally {
    db.close();
  }
}

function withSessionIndex(activity: ChatActivity): ChatActivity {
  if (activity.sessionIndex == null) {
    activity.sessionIndex = getSessionIndexForId(activity.sessionId);
  }
  return activity;
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

function chatSessionExists(sessionId: string): boolean {
  const db = openGlobalDb(true);
  try {
    const row = db
      .prepare("SELECT 1 FROM composerHeaders WHERE composerId = ?")
      .get(sessionId);
    return row != null;
  } finally {
    db.close();
  }
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
    if (chatSessionExists(sessionId)) {
      return;
    }
    await sleep(pollMs);
  }

  throw new Error(`Chat session ${sessionId} not found after ${timeoutMs}ms.`);
}

export function listActiveChats(args: ListActiveChatsArgs = {}): ChatActivity[] {
  const withinMs = args.withinMs ?? 5 * 60 * 1000;
  const limit = args.limit ?? 20;
  const maxScan = args.maxScan ?? Math.max(limit * 4, 40);
  const workspaceFilter = args.workspace?.trim();

  const db = openGlobalDb(true);
  try {
    const rows = db
      .prepare(
        `SELECT composerId, value, lastUpdatedAt
         FROM composerHeaders
         WHERE IFNULL(isSubagent, 0) = 0
         ORDER BY lastUpdatedAt DESC
         LIMIT ?`,
      )
      .all(maxScan) as Array<{ composerId: string; value: string; lastUpdatedAt: number }>;

    const activities: ChatActivity[] = [];
    for (const row of rows) {
      const header = parseHeaderValue(row.value);
      if (workspaceFilter) {
        const workspace = workspaceFromHeader(header);
        if (!workspace.includes(workspaceFilter)) continue;
      }

      const activity = loadComposerActivity(
        db,
        row.composerId,
        row.value,
        row.lastUpdatedAt,
        undefined,
        { scanBubbles: false },
      );

      const isRecent = Date.now() - Date.parse(activity.updatedAt) <= withinMs;
      if (activity.activityLevel === "active" || isRecent || args.includeIdle) {
        activities.push(activity);
      }
      if (activities.length >= limit) break;
    }

    return activities;
  } finally {
    db.close();
  }
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
