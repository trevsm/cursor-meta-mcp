import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

export interface ChatSummary {
  sessionIndex: number;
  id: string;
  title: string;
  workspace: string;
  workspaceId: string;
  timestamp: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  isArchived: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  toolCalls?: Array<{ name: string; status?: string }>;
}

export interface ChatSession extends ChatSummary {
  messages: ChatMessage[];
}

export interface SearchHit {
  rank: number;
  sessionId: string;
  title: string;
  snippet: string;
  updatedAt: string;
}

function globalStorageDir(): string {
  const override = process.env.CURSOR_META_STATE_DB;
  if (override) return override.replace(/[/\\][^/\\]+$/, "");
  return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage");
}

function globalDbFile(): string {
  const override = process.env.CURSOR_META_STATE_DB;
  if (override) return override;
  return join(globalStorageDir(), "state.vscdb");
}

function openGlobalDb(): Database.Database {
  const db = new Database(globalDbFile(), { readonly: true, fileMustExist: true });
  db.pragma("mmap_size = 268435456"); // 256MB mmap — helps on large state.vscdb
  db.pragma("busy_timeout = 2000");
  return db;
}

function openSearchDb(): Database.Database {
  return new Database(join(globalStorageDir(), "conversation-search.db"), { readonly: true });
}

function parseHeaderValue(raw: string) {
  return JSON.parse(raw) as {
    name?: string;
    subtitle?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
    isArchived?: boolean;
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

function extractBubbleText(value: string): { role: "user" | "assistant"; content: string; toolCalls?: ChatMessage["toolCalls"] } {
  const bubble = JSON.parse(value) as {
    type?: number;
    text?: string;
    toolFormerData?: { name?: string; status?: string };
  };
  const role = bubble.type === 2 ? "assistant" : "user";
  const content = (bubble.text ?? "").trim();
  const toolCalls =
    bubble.toolFormerData?.name != null
      ? [{ name: bubble.toolFormerData.name, status: bubble.toolFormerData.status }]
      : undefined;
  return { role, content, toolCalls };
}

export function getSessionIndexForId(id: string): number | undefined {
  const db = openGlobalDb();
  try {
    const row = db
      .prepare(
        `SELECT rn AS sessionIndex
         FROM (
           SELECT composerId,
                  ROW_NUMBER() OVER (ORDER BY lastUpdatedAt DESC) AS rn
           FROM composerHeaders
           WHERE IFNULL(isSubagent, 0) = 0
         )
         WHERE composerId = ?`,
      )
      .get(id) as { sessionIndex?: number } | undefined;
    return row?.sessionIndex;
  } finally {
    db.close();
  }
}

export interface LoadChatOptions {
  /** Max messages to load (most recent). Omit to load up to maxMessagesCap. */
  maxMessages?: number;
}

const DEFAULT_SHOW_MESSAGES = 30;
const MAX_MESSAGES_CAP = 500;
/** Fetch extra bubbles because many are tool-only shells with no text. */
const BUBBLE_FETCH_MULTIPLIER = 12;
const MAX_BUBBLE_FETCH = 180;

function bubbleKeyRange(sessionId: string): { start: string; end: string } {
  const start = `bubbleId:${sessionId}:`;
  const end = `${start.slice(0, -1)};`;
  return { start, end };
}

function loadBubbleMessages(
  db: Database.Database,
  sessionId: string,
  maxMessages: number,
): ChatMessage[] {
  const { start, end } = bubbleKeyRange(sessionId);
  const bubbleLimit = Math.min(
    Math.max(maxMessages * BUBBLE_FETCH_MULTIPLIER, maxMessages),
    MAX_BUBBLE_FETCH,
  );
  const bubbles = db
    .prepare(
      `SELECT value FROM cursorDiskKV
       WHERE key >= ? AND key < ?
       ORDER BY rowid DESC
       LIMIT ?`,
    )
    .all(start, end, bubbleLimit) as Array<{ value: string }>;

  const messages: ChatMessage[] = [];
  for (const bubble of bubbles.reverse()) {
    try {
      const parsed = extractBubbleText(bubble.value);
      if (!parsed.content && !parsed.toolCalls?.length) continue;
      // Skip tool-only shells in previews — they bloat payloads without adding context.
      if (!parsed.content && parsed.toolCalls?.length) continue;
      messages.push(parsed);
      if (messages.length >= maxMessages) break;
    } catch {
      continue;
    }
  }
  return messages;
}

function summaryFromHeaderRow(
  row: {
    composerId: string;
    workspaceId: string;
    createdAt: number;
    lastUpdatedAt: number;
    value: string;
  },
  sessionIndex: number,
): ChatSummary {
  const header = parseHeaderValue(row.value);
  const workspace = workspaceFromHeader(header);
  return {
    sessionIndex,
    id: row.composerId,
    title: header.name ?? "(untitled)",
    workspace,
    workspaceId: row.workspaceId,
    timestamp: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.lastUpdatedAt).toISOString(),
    messageCount: 0,
    preview: header.subtitle ?? "",
    isArchived: Boolean(header.isArchived),
  };
}

export function listChatSummaries(args: {
  limit?: number;
  offset?: number;
  workspace?: string;
  includeTotal?: boolean;
}): { total: number; sessions: ChatSummary[] } {
  const db = openGlobalDb();
  try {
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 20;
    const workspaceFilter = args.workspace?.trim();

    if (workspaceFilter) {
      const rows = db
        .prepare(
          `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
           FROM composerHeaders
           WHERE IFNULL(isSubagent, 0) = 0
           ORDER BY lastUpdatedAt DESC`,
        )
        .all() as Array<{
        composerId: string;
        workspaceId: string;
        createdAt: number;
        lastUpdatedAt: number;
        value: string;
      }>;

      const filtered = rows
        .map((row, index) => summaryFromHeaderRow(row, index + 1))
        .filter((session) => session.workspace.includes(workspaceFilter));
      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit).map((session, index) => ({
        ...session,
        sessionIndex: offset + index + 1,
      }));
      return { total, sessions: page };
    }

    const rows = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
         FROM composerHeaders
         WHERE IFNULL(isSubagent, 0) = 0
         ORDER BY lastUpdatedAt DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<{
      composerId: string;
      workspaceId: string;
      createdAt: number;
      lastUpdatedAt: number;
      value: string;
    }>;

    const sessions = rows.map((row, index) => summaryFromHeaderRow(row, offset + index + 1));
    let total = sessions.length;
    if (args.includeTotal !== false) {
      const totalRow = db
        .prepare(
          `SELECT COUNT(*) AS total FROM composerHeaders WHERE IFNULL(isSubagent, 0) = 0`,
        )
        .get() as { total: number };
      total = totalRow.total;
    } else if (sessions.length === limit) {
      total = offset + limit + 1; // signal hasMore without full COUNT
    } else {
      total = offset + sessions.length;
    }

    return { total, sessions };
  } finally {
    db.close();
  }
}

export function lookupChatSummariesByIds(ids: string[]): Map<string, ChatSummary> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const db = openGlobalDb();
  try {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
         FROM composerHeaders
         WHERE composerId IN (${placeholders})`,
      )
      .all(...uniqueIds) as Array<{
      composerId: string;
      workspaceId: string;
      createdAt: number;
      lastUpdatedAt: number;
      value: string;
    }>;

    const map = new Map<string, ChatSummary>();
    for (const row of rows) {
      map.set(
        row.composerId,
        summaryFromHeaderRow(row, getSessionIndexForId(row.composerId) ?? 0),
      );
    }
    return map;
  } finally {
    db.close();
  }
}

function loadChatSession(
  db: Database.Database,
  id: string,
  summary: ChatSummary | undefined,
  options: LoadChatOptions,
): ChatSession {
  let meta = summary;
  if (!meta) {
    const headerRow = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
         FROM composerHeaders WHERE composerId = ?`,
      )
      .get(id) as {
      composerId: string;
      workspaceId: string;
      createdAt: number;
      lastUpdatedAt: number;
      value?: string;
    } | undefined;

    if (!headerRow?.value) {
      throw new Error(`Chat session ${id} not found.`);
    }

    meta = summaryFromHeaderRow(
      {
        composerId: headerRow.composerId,
        workspaceId: headerRow.workspaceId,
        createdAt: headerRow.createdAt,
        lastUpdatedAt: headerRow.lastUpdatedAt,
        value: headerRow.value,
      },
      getSessionIndexForId(id) ?? 0,
    );
  }

  const maxMessages = Math.min(
    options.maxMessages ?? DEFAULT_SHOW_MESSAGES,
    MAX_MESSAGES_CAP,
  );
  const messages = loadBubbleMessages(db, id, maxMessages);

  return {
    ...meta,
    messageCount: messages.length,
    messages,
  };
}

export function getChatByIndex(sessionIndex: number, options: LoadChatOptions = {}): ChatSession {
  if (!Number.isInteger(sessionIndex) || sessionIndex < 1) {
    throw new Error("sessionIndex must be a positive integer (1-based).");
  }

  const db = openGlobalDb();
  try {
    const headerRow = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
         FROM composerHeaders
         WHERE IFNULL(isSubagent, 0) = 0
         ORDER BY lastUpdatedAt DESC
         LIMIT 1 OFFSET ?`,
      )
      .get(sessionIndex - 1) as {
      composerId: string;
      workspaceId: string;
      createdAt: number;
      lastUpdatedAt: number;
      value: string;
    } | undefined;

    if (!headerRow) {
      throw new Error(`Session #${sessionIndex} not found.`);
    }

    const summary = summaryFromHeaderRow(headerRow, sessionIndex);
    return loadChatSession(db, headerRow.composerId, summary, options);
  } finally {
    db.close();
  }
}

export function getChatById(
  id: string,
  summary?: ChatSummary,
  options: LoadChatOptions = {},
): ChatSession {
  const db = openGlobalDb();
  try {
    return loadChatSession(db, id, summary, options);
  } finally {
    db.close();
  }
}

export function searchChats(args: {
  query: string;
  limit?: number;
}): SearchHit[] {
  const db = openSearchDb();
  try {
    const limit = args.limit ?? 10;
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.updated_at,
                snippet(conversation_fts, 1, '[', ']', '…', 24) AS snippet
         FROM conversation_fts
         JOIN conversations c ON c.fts_rowid = conversation_fts.rowid
         WHERE conversation_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(args.query, limit) as Array<{
      id: string;
      title: string;
      updated_at: number;
      snippet: string;
    }>;

    return rows.map((row, index) => ({
      rank: index + 1,
      sessionId: row.id,
      title: row.title,
      snippet: row.snippet,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  } finally {
    db.close();
  }
}

export function exportChatMarkdown(session: ChatSession): string {
  const lines = [
    `# ${session.title}`,
    "",
    `- Session ID: ${session.id}`,
    `- Workspace: ${session.workspace}`,
    `- Updated: ${session.updatedAt}`,
    "",
  ];
  for (const message of session.messages) {
    lines.push(`## ${message.role}`);
    lines.push(message.content);
    if (message.toolCalls?.length) {
      for (const tool of message.toolCalls) {
        lines.push(`- tool: ${tool.name}${tool.status ? ` (${tool.status})` : ""}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function summarizeSessionForPrompt(session: ChatSession, maxMessages = 12): string {
  const lines = [
    `# Prior Cursor chat: ${session.title}`,
    `Workspace: ${session.workspace}`,
    `Updated: ${session.updatedAt}`,
    "",
  ];
  for (const message of session.messages.slice(-maxMessages)) {
    lines.push(`## ${message.role}`);
    lines.push(message.content.trim());
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function getDefaultDataPath(): string {
  return globalStorageDir();
}
