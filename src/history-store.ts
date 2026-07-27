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
  return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage");
}

function openGlobalDb(): Database.Database {
  return new Database(join(globalStorageDir(), "state.vscdb"), { readonly: true });
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
    const rows = db
      .prepare(
        `SELECT composerId FROM composerHeaders
         WHERE IFNULL(isSubagent, 0) = 0
         ORDER BY lastUpdatedAt DESC`,
      )
      .all() as Array<{ composerId: string }>;
    const index = rows.findIndex((row) => row.composerId === id);
    return index >= 0 ? index + 1 : undefined;
  } finally {
    db.close();
  }
}

export function listChatSummaries(args: {
  limit?: number;
  offset?: number;
  workspace?: string;
}): { total: number; sessions: ChatSummary[] } {
  const db = openGlobalDb();
  try {
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

    let filtered = rows.map((row, index) => {
      const header = parseHeaderValue(row.value);
      const workspace = workspaceFromHeader(header);
      return {
        sessionIndex: index + 1,
        id: row.composerId,
        title: header.name ?? "(untitled)",
        workspace,
        workspaceId: row.workspaceId,
        timestamp: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.lastUpdatedAt).toISOString(),
        messageCount: 0,
        preview: header.subtitle ?? "",
        isArchived: Boolean(header.isArchived),
      } satisfies ChatSummary;
    });

    if (args.workspace) {
      filtered = filtered.filter((session) => session.workspace.includes(args.workspace!));
    }

    const total = filtered.length;
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 20;
    const page = filtered.slice(offset, offset + limit).map((session, index) => ({
      ...session,
      sessionIndex: offset + index + 1,
    }));

    return { total, sessions: page };
  } finally {
    db.close();
  }
}

export function getChatByIndex(sessionIndex: number): ChatSession {
  if (!Number.isInteger(sessionIndex) || sessionIndex < 1) {
    throw new Error("sessionIndex must be a positive integer (1-based).");
  }

  const page = listChatSummaries({ limit: 1, offset: sessionIndex - 1 });
  const summary = page.sessions[0];
  if (!summary) {
    throw new Error(`Session #${sessionIndex} not found (${page.total} sessions available).`);
  }
  return getChatById(summary.id, summary);
}

export function getChatById(id: string, summary?: ChatSummary): ChatSession {
  const db = openGlobalDb();
  try {
    const headerRow = db
      .prepare("SELECT value FROM composerHeaders WHERE composerId = ?")
      .get(id) as { value?: string } | undefined;

    let meta = summary;
    if (!meta && headerRow?.value) {
      const header = parseHeaderValue(headerRow.value);
      meta = {
        sessionIndex: 0,
        id,
        title: header.name ?? "(untitled)",
        workspace: workspaceFromHeader(header),
        workspaceId: "unknown",
        timestamp: new Date(header.createdAt ?? Date.now()).toISOString(),
        updatedAt: new Date(header.lastUpdatedAt ?? Date.now()).toISOString(),
        messageCount: 0,
        preview: header.subtitle ?? "",
        isArchived: Boolean(header.isArchived),
      };
    }

    const bubbles = db
      .prepare(
        "SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC",
      )
      .all(`bubbleId:${id}:%`) as Array<{ value: string }>;

    const messages: ChatMessage[] = [];
    for (const bubble of bubbles) {
      try {
        const parsed = extractBubbleText(bubble.value);
        if (!parsed.content && !parsed.toolCalls?.length) continue;
        messages.push(parsed);
      } catch {
        continue;
      }
    }

    return {
      ...(meta ?? {
        sessionIndex: 0,
        id,
        title: "(untitled)",
        workspace: "unknown",
        workspaceId: "unknown",
        timestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        preview: "",
        isArchived: false,
      }),
      messageCount: messages.length,
      messages,
    };
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
