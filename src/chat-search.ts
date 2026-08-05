import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

import { getChatByIndex, getSessionIndexForId } from "./history-store.js";

export type SearchScope = "thinking" | "user" | "assistant";

export interface ThinkingSearchHit {
  rank: number;
  sessionIndex: number | null;
  sessionId: string;
  title: string;
  workspace: string | null;
  turn: number;
  scope: SearchScope;
  at: string | null;
  matched: string;
  quote: string;
  charCount: number;
  userPreview: string;
}

export interface ThinkingSearchResult {
  query: string;
  mode: "literal" | "regex" | "any";
  scopes: SearchScope[];
  hitCount: number;
  sessionsScanned: number;
  bubblesScanned: number;
  truncated: boolean;
  elapsedMs: number;
  note: string;
  hits: ThinkingSearchHit[];
}

interface SessionHeader {
  composerId: string;
  title: string;
  workspace: string | null;
  sessionIndex: number | null;
}

interface BubbleJson {
  type?: number;
  text?: string;
  createdAt?: string;
  thinking?: { text?: string };
  allThinkingBlocks?: Array<{ text?: string }>;
  toolFormerData?: { name?: string };
}

function globalDbFile(): string {
  const override = process.env.CURSOR_META_STATE_DB;
  if (override) return override;
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function openGlobalDb(): Database.Database {
  const db = new Database(globalDbFile(), { readonly: true, fileMustExist: true });
  db.pragma("mmap_size = 268435456");
  db.pragma("busy_timeout = 2000");
  return db;
}

function bubbleKeyRange(sessionId: string): { start: string; end: string } {
  const start = `bubbleId:${sessionId}:`;
  const end = `${start.slice(0, -1)};`;
  return { start, end };
}

function userPreviewFromText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (/browser_element/i.test(t)) {
    const tag = t.match(/tag:\s*(\w+)/i)?.[1] ?? "click";
    return `[browser_element] ${tag}`;
  }
  if (/follow-up actions in response to the subagent/i.test(t)) return "[subagent follow-up]";
  if (/task result and perform any follow-up/i.test(t)) return "[task follow-up]";
  const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return (m ? m[1] : t).replace(/\s+/g, " ").trim().slice(0, 160);
}

function extractThinkingText(bubble: BubbleJson): string {
  const primary = (bubble.thinking?.text ?? "").trim();
  if (primary) return primary;
  return (bubble.allThinkingBlocks ?? [])
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function clipAroundMatch(
  text: string,
  matched: string,
  quoteChars: number,
  caseSensitive: boolean,
): string {
  if (quoteChars <= 0 || text.length <= quoteChars) return text;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? matched : matched.toLowerCase();
  const at = hay.indexOf(needle);
  if (at < 0) return `${text.slice(0, quoteChars)}…`;
  const half = Math.floor((quoteChars - matched.length) / 2);
  const start = Math.max(0, at - Math.max(half, 40));
  const end = Math.min(text.length, start + quoteChars);
  const slice = text.slice(start, end);
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

function longestLiteralRun(pattern: string): string | null {
  const runs = pattern.match(/[a-zA-Z0-9_\-]{3,}/g);
  if (!runs?.length) return null;
  return runs.sort((a, b) => b.length - a.length)[0] ?? null;
}

function compileMatcher(args: {
  query: string;
  queries?: string[];
  regex?: boolean;
  caseSensitive?: boolean;
}): {
  mode: "literal" | "regex" | "any";
  displayQuery: string;
  prefilters: string[];
  match: (text: string) => string | null;
} {
  const caseSensitive = Boolean(args.caseSensitive);
  const extras = (args.queries ?? []).map((q) => q.trim()).filter(Boolean);
  const primary = args.query.trim();
  const all = [primary, ...extras].filter(Boolean);
  if (all.length === 0) throw new Error("Provide query or queries.");

  if (args.regex) {
    if (extras.length > 0) {
      throw new Error("regex mode accepts a single query pattern (not queries[]).");
    }
    let re: RegExp;
    try {
      re = new RegExp(primary, caseSensitive ? "g" : "gi");
    } catch (error) {
      throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
    }
    const lit = longestLiteralRun(primary);
    return {
      mode: "regex",
      displayQuery: primary,
      prefilters: lit ? [caseSensitive ? lit : lit.toLowerCase()] : [],
      match: (text) => {
        re.lastIndex = 0;
        const m = re.exec(text);
        return m?.[0] ?? null;
      },
    };
  }

  if (all.length === 1) {
    const original = all[0]!;
    const needle = caseSensitive ? original : original.toLowerCase();
    return {
      mode: "literal",
      displayQuery: original,
      prefilters: [needle],
      match: (text) => {
        const hay = caseSensitive ? text : text.toLowerCase();
        return hay.includes(needle) ? original : null;
      },
    };
  }

  const needles = all.map((q) => (caseSensitive ? q : q.toLowerCase()));
  return {
    mode: "any",
    displayQuery: all.join(" | "),
    prefilters: needles,
    match: (text) => {
      const hay = caseSensitive ? text : text.toLowerCase();
      for (let i = 0; i < needles.length; i++) {
        if (hay.includes(needles[i]!)) return all[i]!;
      }
      return null;
    },
  };
}

function parseSessionHeader(row: {
  composerId: string;
  workspaceId: string;
  value: string;
}): Omit<SessionHeader, "sessionIndex"> {
  let title = "(untitled)";
  let workspace: string | null = row.workspaceId || null;
  try {
    const header = JSON.parse(row.value) as {
      name?: string;
      workspaceIdentifier?: { uri?: { fsPath?: string; path?: string }; id?: string };
    };
    title = header.name ?? title;
    const uri = header.workspaceIdentifier?.uri;
    workspace = uri?.fsPath ?? uri?.path ?? header.workspaceIdentifier?.id ?? workspace;
  } catch {
    // keep defaults
  }
  return { composerId: row.composerId, title, workspace };
}

function listRecentSessions(db: Database.Database, maxSessions: number): SessionHeader[] {
  const rows = db
    .prepare(
      `SELECT composerId, workspaceId, value
       FROM composerHeaders
       WHERE IFNULL(isSubagent, 0) = 0
       ORDER BY lastUpdatedAt DESC
       LIMIT ?`,
    )
    .all(maxSessions) as Array<{ composerId: string; workspaceId: string; value: string }>;

  return rows.map((row, index) => ({
    ...parseSessionHeader(row),
    sessionIndex: index + 1,
  }));
}

function resolveTargetSessions(
  db: Database.Database,
  args: {
    sessionId?: string;
    sessionIndex?: number;
    maxSessions: number;
  },
): SessionHeader[] {
  if (args.sessionIndex != null) {
    const chat = getChatByIndex(args.sessionIndex, { maxMessages: 1 });
    return [
      {
        composerId: chat.id,
        title: chat.title,
        workspace: chat.workspace,
        sessionIndex: chat.sessionIndex,
      },
    ];
  }
  if (args.sessionId) {
    const header = db
      .prepare(
        `SELECT composerId, workspaceId, value FROM composerHeaders WHERE composerId = ?`,
      )
      .get(args.sessionId) as { composerId: string; workspaceId: string; value: string } | undefined;
    if (!header) throw new Error(`Session ${args.sessionId} not found.`);
    return [
      {
        ...parseSessionHeader(header),
        sessionIndex: getSessionIndexForId(header.composerId) ?? null,
      },
    ];
  }
  return listRecentSessions(db, args.maxSessions);
}

function rawMayMatch(
  raw: string,
  prefilters: string[],
  caseSensitive: boolean,
): boolean {
  if (prefilters.length === 0) return true;
  if (caseSensitive) return prefilters.some((p) => raw.includes(p));
  const lower = raw.toLowerCase();
  return prefilters.some((p) => lower.includes(p));
}

/**
 * Fast cross-chat search over thinking.text and user prompts (default), optional assistant text.
 * Streams per-session bubbles with raw prefilters — does not materialize entire chats.
 */
export function searchThinking(args: {
  query: string;
  /** Additional literal OR terms (ignored in regex mode). */
  queries?: string[];
  regex?: boolean;
  caseSensitive?: boolean;
  scopes?: SearchScope[];
  sessionId?: string;
  sessionIndex?: number;
  /** Max recent sessions to scan (default 100). Ignored when sessionId/Index set. */
  maxSessions?: number;
  /** Max hits to return (default 30). */
  limit?: number;
  /** Skip texts shorter than this (default 1 when user in scope; 40 for thinking-only). */
  minChars?: number;
  /** Quote window around match (default 280). 0 = up to 4000 chars. */
  quoteChars?: number;
  /** Soft cap bubbles scanned per session (default 100000). */
  maxBubblesPerSession?: number;
}): ThinkingSearchResult {
  const scopes: SearchScope[] =
    args.scopes && args.scopes.length > 0
      ? [...new Set(args.scopes)]
      : ["thinking", "user"];
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 200);
  const maxSessions = Math.min(Math.max(args.maxSessions ?? 100, 1), 500);
  const thinkingOnly = scopes.length === 1 && scopes[0] === "thinking";
  const minChars = args.minChars ?? (thinkingOnly ? 40 : 1);
  const quoteChars = args.quoteChars ?? 280;
  const maxBubblesPerSession = args.maxBubblesPerSession ?? 100_000;
  const caseSensitive = Boolean(args.caseSensitive);
  const quoteLimit = quoteChars === 0 ? 4000 : quoteChars;

  const matcher = compileMatcher({
    query: args.query,
    queries: args.queries,
    regex: args.regex,
    caseSensitive,
  });

  const db = openGlobalDb();
  const started = Date.now();
  try {
    const sessions = resolveTargetSessions(db, {
      sessionId: args.sessionId,
      sessionIndex: args.sessionIndex,
      maxSessions,
    });

    const hits: ThinkingSearchHit[] = [];
    let bubblesScanned = 0;
    let truncated = false;

    const bubbleStmt = db.prepare(
      `SELECT value FROM cursorDiskKV
       WHERE key >= ? AND key < ?
       ORDER BY rowid ASC`,
    );

    for (let sessionIdx = 0; sessionIdx < sessions.length; sessionIdx++) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const session = sessions[sessionIdx]!;
      const { start, end } = bubbleKeyRange(session.composerId);
      const iter = bubbleStmt.iterate(start, end) as IterableIterator<{ value: string }>;

      let turn = 0;
      let userPreview = "";
      let bubblesInSession = 0;

      for (const row of iter) {
        bubblesInSession += 1;
        bubblesScanned += 1;
        if (bubblesInSession > maxBubblesPerSession) {
          truncated = true;
          break;
        }
        if (hits.length >= limit) {
          truncated = true;
          break;
        }

        const raw = row.value;
        const maybeUser = raw.includes('"type":1') || raw.includes('"type": 1');
        const maybeHit = rawMayMatch(raw, matcher.prefilters, caseSensitive);
        if (!maybeUser && !maybeHit) continue;

        let bubble: BubbleJson;
        try {
          bubble = JSON.parse(raw) as BubbleJson;
        } catch {
          continue;
        }

        if (bubble.type === 1) {
          turn += 1;
          userPreview = userPreviewFromText(bubble.text ?? "");
          if (scopes.includes("user") && bubble.text?.trim()) {
            const text = bubble.text.trim();
            if (text.length >= minChars) {
              const matched = matcher.match(text);
              if (matched) {
                const cleaned = userPreviewFromText(text);
                const quoteSource =
                  cleaned && matcher.match(cleaned) ? cleaned : text;
                hits.push({
                  rank: hits.length + 1,
                  sessionIndex: session.sessionIndex,
                  sessionId: session.composerId,
                  title: session.title,
                  workspace: session.workspace,
                  turn,
                  scope: "user",
                  at: bubble.createdAt ?? null,
                  matched,
                  quote: clipAroundMatch(quoteSource, matched, quoteLimit, caseSensitive),
                  charCount: text.length,
                  userPreview: cleaned || userPreview,
                });
              }
            }
          }
          continue;
        }

        if (!maybeHit) continue;

        if (scopes.includes("thinking")) {
          const thinking = extractThinkingText(bubble);
          if (thinking.length >= minChars) {
            const matched = matcher.match(thinking);
            if (matched) {
              hits.push({
                rank: hits.length + 1,
                sessionIndex: session.sessionIndex,
                sessionId: session.composerId,
                title: session.title,
                workspace: session.workspace,
                turn: Math.max(turn, 1),
                scope: "thinking",
                at: bubble.createdAt ?? null,
                matched,
                quote: clipAroundMatch(thinking, matched, quoteLimit, caseSensitive),
                charCount: thinking.length,
                userPreview,
              });
              if (hits.length >= limit) break;
            }
          }
        }

        if (
          scopes.includes("assistant") &&
          !bubble.toolFormerData?.name &&
          bubble.text?.trim()
        ) {
          const text = bubble.text.trim();
          if (text.length >= minChars) {
            const matched = matcher.match(text);
            if (matched) {
              hits.push({
                rank: hits.length + 1,
                sessionIndex: session.sessionIndex,
                sessionId: session.composerId,
                title: session.title,
                workspace: session.workspace,
                turn: Math.max(turn, 1),
                scope: "assistant",
                at: bubble.createdAt ?? null,
                matched,
                quote: clipAroundMatch(text, matched, quoteLimit, caseSensitive),
                charCount: text.length,
                userPreview,
              });
              if (hits.length >= limit) break;
            }
          }
        }
      }
    }

    return {
      query: matcher.displayQuery,
      mode: matcher.mode,
      scopes,
      hitCount: hits.length,
      sessionsScanned: sessions.length,
      bubblesScanned,
      truncated,
      elapsedMs: Date.now() - started,
      note: "Searches literal bubble text in state.vscdb — thinking.text and user prompts by default (add assistant via scopes). Not conversation-search.db FTS. Pass queries[] for OR literals, or regex:true.",
      hits,
    };
  } finally {
    db.close();
  }
}

export function thinkingSearchErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
