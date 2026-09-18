import { describeError } from "./errors.js";
import {
  exportChatMarkdown,
  getChatById,
  getChatByIndex,
  getDefaultDataPath,
  listChatSummaries,
  searchChats as searchStoredChats,
  summarizeSessionForPrompt,
  type ChatSession,
} from "./history-store.js";

export async function listChats(args: {
  limit?: number;
  offset?: number;
  workspace?: string;
  includeEmpty?: boolean;
}) {
  const includeEmpty = args.includeEmpty ?? false;
  const result = listChatSummaries({
    ...args,
    includeEmpty,
    includeTotal: true,
  });
  return {
    defaultDataPath: getDefaultDataPath(),
    pagination: {
      total: result.total,
      limit: args.limit ?? 20,
      offset: args.offset ?? 0,
      hasMore: result.hasMore,
    },
    filters: {
      workspace: args.workspace ?? null,
      includeEmpty,
    },
    note: includeEmpty
      ? undefined
      : "Chats with zero stored messages are hidden; pass includeEmpty to see them. sessionIndex stays global, so it is not contiguous here.",
    sessions: result.sessions,
  };
}

export async function showChat(args: {
  sessionIndex?: number;
  sessionId?: string;
  maxMessages?: number;
  fromStart?: boolean;
}) {
  const options = { maxMessages: args.maxMessages, fromStart: args.fromStart };
  const session = args.sessionId
    ? getChatById(args.sessionId, undefined, options)
    : args.sessionIndex != null
      ? getChatByIndex(args.sessionIndex, options)
      : null;
  if (!session) throw new Error("Provide sessionIndex or sessionId.");

  return {
    ...session,
    note: session.truncated
      ? `Showing the ${session.window} ${session.messageCount} messages of ${session.bubbleCount} stored bubbles. Raise maxMessages, pass fromStart to read the opening, or use meta_chat_turns for full traversal.`
      : undefined,
  };
}

export async function searchChats(args: {
  query: string;
  limit?: number;
  context?: number;
  workspace?: string;
}) {
  const result = searchStoredChats(args);
  return {
    query: args.query,
    queryMode: result.queryMode,
    effectiveQuery: result.effectiveQuery,
    workspace: args.workspace ?? null,
    hitCount: result.hits.length,
    note:
      result.queryMode === "raw"
        ? undefined
        : `Raw query was not valid FTS5 syntax; re-ran as a ${result.queryMode} query (${result.effectiveQuery}).`,
    hits: result.hits,
  };
}

export async function exportChat(args: {
  sessionIndex?: number;
  sessionId?: string;
  format?: "markdown" | "json";
}) {
  const session = args.sessionId
    ? getChatById(args.sessionId, undefined, { maxMessages: 500 })
    : args.sessionIndex != null
      ? getChatByIndex(args.sessionIndex, { maxMessages: 500 })
      : null;
  if (!session) throw new Error("Provide sessionIndex or sessionId.");

  if (args.format === "json") {
    return { format: "json", content: JSON.stringify(session, null, 2) };
  }
  return { format: "markdown", content: exportChatMarkdown(session) };
}

export async function loadSessionSummary(
  sessionIndex: number,
  maxMessages = 12,
): Promise<string> {
  const session = getChatByIndex(sessionIndex, { maxMessages: maxMessages + 4 });
  return summarizeSessionForPrompt(session, maxMessages);
}

export async function loadSessionSummaryById(
  sessionId: string,
  maxMessages = 12,
): Promise<string> {
  const session = getChatById(sessionId, undefined, { maxMessages: maxMessages + 4 });
  return summarizeSessionForPrompt(session, maxMessages);
}

export function historyErrorMessage(error: unknown): string {
  return describeError(error);
}

export type { ChatSession };
