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
  /** Stored bubbles for this chat. 0 means an empty shell with no conversation. */
  bubbleCount: number;
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
  /** True when the chat holds more messages than were returned. */
  truncated: boolean;
  /** Which end of the transcript `messages` came from. */
  window: "latest" | "earliest";
}

export interface SearchHit {
  rank: number;
  sessionId: string;
  sessionIndex?: number;
  title: string;
  snippet: string;
  updatedAt: string;
  workspace: string | null;
  /** Chat contains the FIXORIGIN marker — a verified origin fix, not just a mention. */
  hasFixOrigin: boolean;
}

/**
 * How the raw query reached FTS5. Agents paste error text containing `:`, `!`, and `.`,
 * all of which are FTS5 operators, so a raw MATCH throws instead of returning nothing.
 */
export type FtsQueryMode = "raw" | "phrase" | "terms";

export interface SearchResult {
  hits: SearchHit[];
  queryMode: FtsQueryMode;
  effectiveQuery: string;
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
  /** Read from the start of the chat instead of the most recent messages. */
  fromStart?: boolean;
}

const DEFAULT_SHOW_MESSAGES = 30;
const MAX_MESSAGES_CAP = 500;
/** Bound the worst case on chats with tens of thousands of bubbles. */
const MAX_BUBBLE_SCAN = 40_000;

function bubbleKeyRange(sessionId: string): { start: string; end: string } {
  const start = `bubbleId:${sessionId}:`;
  const end = `${start.slice(0, -1)};`;
  return { start, end };
}

function countBubbles(db: Database.Database, sessionId: string): number {
  const { start, end } = bubbleKeyRange(sessionId);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM cursorDiskKV WHERE key >= ? AND key < ?`)
    .get(start, end) as { n: number };
  return row.n;
}

/** ~100x cheaper than COUNT over the key range — use this to screen empty shells. */
function hasBubbles(db: Database.Database, sessionId: string): boolean {
  const { start, end } = bubbleKeyRange(sessionId);
  return (
    db
      .prepare(`SELECT 1 FROM cursorDiskKV WHERE key >= ? AND key < ? LIMIT 1`)
      .get(start, end) !== undefined
  );
}

/**
 * Stream bubbles and stop once `maxMessages` texts are collected. Most bubbles are
 * tool-only shells with no text, so a fixed row LIMIT silently under-delivers.
 */
function loadBubbleMessages(
  db: Database.Database,
  sessionId: string,
  maxMessages: number,
  fromStart: boolean,
): { messages: ChatMessage[]; truncated: boolean } {
  const { start, end } = bubbleKeyRange(sessionId);
  const iter = db
    .prepare(
      `SELECT value FROM cursorDiskKV
       WHERE key >= ? AND key < ?
       ORDER BY rowid ${fromStart ? "ASC" : "DESC"}`,
    )
    .iterate(start, end) as IterableIterator<{ value: string }>;

  const collected: ChatMessage[] = [];
  let scanned = 0;
  let truncated = false;

  for (const bubble of iter) {
    scanned += 1;
    if (scanned > MAX_BUBBLE_SCAN) {
      truncated = true;
      break;
    }
    let parsed: ChatMessage;
    try {
      parsed = extractBubbleText(bubble.value);
    } catch {
      continue;
    }
    // Skip tool-only shells — they bloat payloads without adding context.
    if (!parsed.content) continue;
    collected.push(parsed);
    // Collect one extra so `truncated` reflects real overflow, not an exact fit.
    if (collected.length > maxMessages) {
      collected.pop();
      truncated = true;
      break;
    }
  }

  return {
    messages: fromStart ? collected : collected.reverse(),
    truncated,
  };
}

interface HeaderRow {
  composerId: string;
  workspaceId: string;
  createdAt: number;
  lastUpdatedAt: number;
  value: string;
}

function summaryFromHeaderRow(
  row: HeaderRow,
  sessionIndex: number,
  bubbleCount = 0,
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
    bubbleCount,
    preview: header.subtitle ?? "",
    isArchived: Boolean(header.isArchived),
  };
}

const HEADER_COLUMNS = `composerId, workspaceId, createdAt, lastUpdatedAt, value`;
const NON_SUBAGENT = `IFNULL(isSubagent, 0) = 0`;

export function listChatSummaries(args: {
  limit?: number;
  offset?: number;
  workspace?: string;
  /** Include chats with zero bubbles. Defaults true so `offset` stays a global index. */
  includeEmpty?: boolean;
  includeTotal?: boolean;
}): { total: number | null; hasMore: boolean; sessions: ChatSummary[] } {
  const db = openGlobalDb();
  try {
    const offset = Math.max(args.offset ?? 0, 0);
    const limit = Math.max(args.limit ?? 20, 1);
    const workspaceFilter = args.workspace?.trim();
    const includeEmpty = args.includeEmpty ?? true;
    const isFiltered = Boolean(workspaceFilter) || !includeEmpty;

    // Unfiltered listing lines up 1:1 with the global index, so SQL can page it.
    if (!isFiltered) {
      const rows = db
        .prepare(
          `SELECT ${HEADER_COLUMNS} FROM composerHeaders
           WHERE ${NON_SUBAGENT}
           ORDER BY lastUpdatedAt DESC
           LIMIT ? OFFSET ?`,
        )
        .all(limit + 1, offset) as HeaderRow[];

      const hasMore = rows.length > limit;
      const sessions = rows
        .slice(0, limit)
        .map((row, index) =>
          summaryFromHeaderRow(row, offset + index + 1, countBubbles(db, row.composerId)),
        );
      const total =
        args.includeTotal === false
          ? null
          : (
              db
                .prepare(`SELECT COUNT(*) AS n FROM composerHeaders WHERE ${NON_SUBAGENT}`)
                .get() as { n: number }
            ).n;
      return { total, hasMore, sessions };
    }

    // Filtered: walk in global order and keep the real sessionIndex. Renumbering by
    // page position hands back indexes that resolve to a different chat entirely.
    const iter = db
      .prepare(
        `SELECT ${HEADER_COLUMNS} FROM composerHeaders
         WHERE ${NON_SUBAGENT}
         ORDER BY lastUpdatedAt DESC`,
      )
      .iterate() as IterableIterator<HeaderRow>;

    const sessions: ChatSummary[] = [];
    const wantTotal = args.includeTotal === true;
    let globalIndex = 0;
    let matched = 0;
    let hasMore = false;

    for (const row of iter) {
      globalIndex += 1;
      if (workspaceFilter) {
        const workspace = workspaceFromHeader(parseHeaderValue(row.value));
        if (!workspace.includes(workspaceFilter)) continue;
      }
      if (!includeEmpty && !hasBubbles(db, row.composerId)) continue;

      matched += 1;
      if (matched <= offset) continue;
      if (sessions.length < limit) {
        // Exact counts only for rows we actually return.
        sessions.push(summaryFromHeaderRow(row, globalIndex, countBubbles(db, row.composerId)));
        continue;
      }
      hasMore = true;
      if (!wantTotal) break;
    }

    return { total: wantTotal ? matched : null, hasMore, sessions };
  } finally {
    db.close();
  }
}

/** One window-function pass instead of a full scan per id. */
export function getSessionIndexesForIds(ids: string[]): Map<string, number> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const db = openGlobalDb();
  try {
    const placeholders = unique.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT composerId, sessionIndex FROM (
           SELECT composerId,
                  ROW_NUMBER() OVER (ORDER BY lastUpdatedAt DESC) AS sessionIndex
           FROM composerHeaders
           WHERE ${NON_SUBAGENT}
         )
         WHERE composerId IN (${placeholders})`,
      )
      .all(...unique) as Array<{ composerId: string; sessionIndex: number }>;
    return new Map(rows.map((row) => [row.composerId, row.sessionIndex]));
  } finally {
    db.close();
  }
}

/** Workspace path per chat id, read from composerHeaders (the FTS db has no workspace). */
export function lookupWorkspacesByIds(ids: string[]): Map<string, string> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const db = openGlobalDb();
  try {
    const placeholders = unique.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT composerId, value FROM composerHeaders WHERE composerId IN (${placeholders})`,
      )
      .all(...unique) as Array<{ composerId: string; value: string }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      try {
        map.set(row.composerId, workspaceFromHeader(parseHeaderValue(row.value)));
      } catch {
        continue;
      }
    }
    return map;
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
        `SELECT ${HEADER_COLUMNS} FROM composerHeaders WHERE composerId IN (${placeholders})`,
      )
      .all(...uniqueIds) as HeaderRow[];

    const indexes = getSessionIndexesForIds(rows.map((row) => row.composerId));
    const map = new Map<string, ChatSummary>();
    for (const row of rows) {
      map.set(
        row.composerId,
        summaryFromHeaderRow(
          row,
          indexes.get(row.composerId) ?? 0,
          countBubbles(db, row.composerId),
        ),
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
      .prepare(`SELECT ${HEADER_COLUMNS} FROM composerHeaders WHERE composerId = ?`)
      .get(id) as (Omit<HeaderRow, "value"> & { value?: string }) | undefined;

    if (!headerRow?.value) {
      throw new Error(`Chat session ${id} not found.`);
    }

    meta = summaryFromHeaderRow(
      { ...headerRow, value: headerRow.value },
      getSessionIndexForId(id) ?? 0,
    );
  }

  const maxMessages = Math.min(
    options.maxMessages ?? DEFAULT_SHOW_MESSAGES,
    MAX_MESSAGES_CAP,
  );
  const fromStart = Boolean(options.fromStart);
  const { messages, truncated } = loadBubbleMessages(db, id, maxMessages, fromStart);

  return {
    ...meta,
    messageCount: messages.length,
    bubbleCount: countBubbles(db, id),
    truncated,
    window: fromStart ? "earliest" : "latest",
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

interface FtsRow {
  id: string;
  title: string;
  updated_at: number;
  snippet: string;
}

/** FTS5 tokenizes on non-alphanumerics, so query terms reduce to the same runs. */
function ftsTokens(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function quotedPhrase(query: string): string | null {
  const tokens = ftsTokens(query);
  return tokens.length > 0 ? `"${tokens.join(" ")}"` : null;
}

function quotedTerms(query: string): string | null {
  const tokens = ftsTokens(query);
  return tokens.length > 0 ? tokens.map((token) => `"${token}"`).join(" ") : null;
}

function runFtsQuery(
  db: Database.Database,
  matchExpr: string,
  limit: number,
  snippetTokens: number,
): FtsRow[] {
  return db
    .prepare(
      `SELECT c.id, c.title, c.updated_at,
              snippet(conversation_fts, 1, '[', ']', '…', ?) AS snippet
       FROM conversation_fts
       JOIN conversations c ON c.fts_rowid = conversation_fts.rowid
       WHERE conversation_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(snippetTokens, matchExpr, limit) as FtsRow[];
}

/**
 * Agents search with raw error text. `ReferenceError:`, `npm ERR!`, and `field.required`
 * are all FTS5 syntax errors, which surfaced as opaque SQLite failures rather than
 * "no results". Try the query as written, then as a quoted phrase, then as ANDed terms.
 */
function searchWithFallback(
  db: Database.Database,
  query: string,
  limit: number,
  snippetTokens: number,
): { rows: FtsRow[]; queryMode: FtsQueryMode; effectiveQuery: string } {
  const phrase = quotedPhrase(query);
  const terms = quotedTerms(query);
  const attempts: Array<{ mode: FtsQueryMode; expr: string }> = [{ mode: "raw", expr: query }];
  if (phrase && phrase !== query) attempts.push({ mode: "phrase", expr: phrase });
  if (terms && terms !== phrase && terms !== query) attempts.push({ mode: "terms", expr: terms });

  let firstValid: { rows: FtsRow[]; queryMode: FtsQueryMode; effectiveQuery: string } | null = null;
  let lastError: unknown;

  for (const attempt of attempts) {
    let rows: FtsRow[];
    try {
      rows = runFtsQuery(db, attempt.expr, limit, snippetTokens);
    } catch (error) {
      lastError = error;
      continue;
    }
    const result = { rows, queryMode: attempt.mode, effectiveQuery: attempt.expr };
    if (rows.length > 0) return result;
    firstValid ??= result;
  }

  if (firstValid) return firstValid;
  throw new Error(
    `Could not search for ${JSON.stringify(query)}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/** Chats carrying the FIXORIGIN marker, so hits can be ranked as verified fixes. */
function fixOriginIds(db: Database.Database): Set<string> {
  try {
    const rows = db
      .prepare(
        `SELECT c.id FROM conversation_fts
         JOIN conversations c ON c.fts_rowid = conversation_fts.rowid
         WHERE conversation_fts MATCH 'FIXORIGIN'`,
      )
      .all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  } catch {
    return new Set();
  }
}

export function searchChats(args: {
  query: string;
  limit?: number;
  workspace?: string;
  /** Snippet width in tokens (default 24). */
  context?: number;
}): SearchResult {
  const db = openSearchDb();
  try {
    const limit = Math.max(args.limit ?? 10, 1);
    const snippetTokens = Math.min(Math.max(args.context ?? 24, 8), 64);
    const workspaceFilter = args.workspace?.trim();
    // Workspace lives in state.vscdb, not the FTS db, so over-fetch and filter after.
    const fetchLimit = workspaceFilter ? Math.min(limit * 8, 200) : limit;

    const { rows, queryMode, effectiveQuery } = searchWithFallback(
      db,
      args.query,
      fetchLimit,
      snippetTokens,
    );
    const marked = fixOriginIds(db);
    const ids = rows.map((row) => row.id);
    const workspaces = lookupWorkspacesByIds(ids);

    const filtered = workspaceFilter
      ? rows.filter((row) => (workspaces.get(row.id) ?? "").includes(workspaceFilter))
      : rows;
    const page = filtered.slice(0, limit);
    const indexes = getSessionIndexesForIds(page.map((row) => row.id));

    return {
      queryMode,
      effectiveQuery,
      hits: page.map((row, index) => ({
        rank: index + 1,
        sessionId: row.id,
        sessionIndex: indexes.get(row.id),
        title: row.title,
        snippet: row.snippet,
        updatedAt: new Date(row.updated_at).toISOString(),
        workspace: workspaces.get(row.id) ?? null,
        hasFixOrigin: marked.has(row.id),
      })),
    };
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
