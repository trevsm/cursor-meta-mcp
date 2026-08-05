import { describeError } from "./errors.js";
import {
  exportChatMarkdown,
  getChatById,
  getChatByIndex,
  getDefaultDataPath,
  getSessionIndexForId,
  listChatSummaries,
  searchChats as searchStoredChats,
  summarizeSessionForPrompt,
  type ChatSession,
} from "./history-store.js";

export async function listChats(args: {
  limit?: number;
  offset?: number;
  workspace?: string;
}) {
  const result = listChatSummaries({ ...args, includeTotal: args.offset === 0 ? true : false });
  return {
    defaultDataPath: getDefaultDataPath(),
    pagination: {
      total: result.total,
      limit: args.limit ?? 20,
      offset: args.offset ?? 0,
      hasMore: (args.offset ?? 0) + result.sessions.length < result.total,
    },
    sessions: result.sessions,
  };
}

export async function showChat(args: {
  sessionIndex?: number;
  sessionId?: string;
  maxMessages?: number;
}) {
  const options = { maxMessages: args.maxMessages };
  if (args.sessionId) {
    return getChatById(args.sessionId, undefined, options);
  }
  if (args.sessionIndex != null) {
    return getChatByIndex(args.sessionIndex, options);
  }
  throw new Error("Provide sessionIndex or sessionId.");
}

export async function searchChats(args: {
  query: string;
  limit?: number;
  context?: number;
  workspace?: string;
}) {
  const hits = searchStoredChats({ query: args.query, limit: args.limit });
  return hits.map((hit) => ({
    ...hit,
    sessionIndex: getSessionIndexForId(hit.sessionId),
  }));
}

export async function exportChat(args: {
  sessionIndex: number;
  format?: "markdown" | "json";
}) {
  const session = getChatByIndex(args.sessionIndex, { maxMessages: 500 });
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
