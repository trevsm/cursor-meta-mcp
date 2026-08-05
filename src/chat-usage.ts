import {
  aggregateUsageByConversation,
  fetchAllUsageEventsInRange,
  fetchCurrentPeriodUsage,
  formatCents,
  resolveUsageDateRange,
  type ConversationUsageTotals,
  type PeriodUsageSummary,
} from "./dashboard-usage.js";
import {
  getChatByIndex,
  getSessionIndexForId,
  listChatSummaries,
  lookupChatSummariesByIds,
  type ChatSummary,
} from "./history-store.js";

export interface ChatUsageRow extends ConversationUsageTotals {
  sessionIndex?: number;
  title?: string;
  workspace?: string;
  chatUpdatedAt?: string;
  chargedDollars: string;
  includedDollars: string;
  onDemandDollars: string;
}

function enrichUsageRows(
  totals: ConversationUsageTotals[],
  lookup?: Map<string, ChatSummary>,
): ChatUsageRow[] {
  return totals.map((row) => {
    const chat = lookup?.get(row.conversationId);
    return {
      ...row,
      sessionIndex: chat ? getSessionIndexForId(row.conversationId) : undefined,
      title: chat?.title,
      workspace: chat?.workspace,
      chatUpdatedAt: chat?.updatedAt,
      chargedDollars: formatCents(row.chargedCents),
      includedDollars: formatCents(row.includedCents),
      onDemandDollars: formatCents(row.onDemandCents),
    };
  });
}

function buildChatLookup(sessions: ChatSummary[]): Map<string, ChatSummary> {
  return new Map(sessions.map((session) => [session.id, session]));
}

function emptyTotals(conversationId: string): ConversationUsageTotals {
  return {
    conversationId,
    eventCount: 0,
    chargedCents: 0,
    includedCents: 0,
    onDemandCents: 0,
    freeCreditCents: 0,
    notChargedCents: 0,
    otherCents: 0,
    includedEventCount: 0,
    onDemandEventCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    models: [],
    firstEventAt: null,
    lastEventAt: null,
  };
}

export async function getUsagePeriod(): Promise<{
  period: PeriodUsageSummary;
  note: string;
}> {
  const period = await fetchCurrentPeriodUsage();
  return {
    period,
    note:
      "includedDollars = plan/bonus usage value (not always cash). onDemandDollars = pay-as-you-go. chargedDollars = sum of chargedCents.",
  };
}

export async function listChatUsage(args: {
  startDate?: string;
  endDate?: string;
  limit?: number;
  minCents?: number;
}) {
  const { startDateMs, endDateMs, source } = await resolveUsageDateRange(args);
  const events = await fetchAllUsageEventsInRange({ startDateMs, endDateMs });
  const aggregated = aggregateUsageByConversation(events);
  const lookup = lookupChatSummariesByIds(aggregated.map((row) => row.conversationId));

  let rows = enrichUsageRows(aggregated, lookup);
  if (args.minCents != null) {
    rows = rows.filter((row) => row.chargedCents >= args.minCents!);
  }
  rows = rows.slice(0, args.limit ?? 50);

  const totalChargedCents = aggregated.reduce((sum, row) => sum + row.chargedCents, 0);
  const totalIncludedCents = aggregated.reduce((sum, row) => sum + row.includedCents, 0);
  const totalOnDemandCents = aggregated.reduce((sum, row) => sum + row.onDemandCents, 0);

  return {
    dateRange: {
      start: new Date(startDateMs).toISOString(),
      end: new Date(endDateMs).toISOString(),
      source,
    },
    totalEvents: events.length,
    totalConversations: aggregated.length,
    totalChargedCents,
    totalChargedDollars: formatCents(totalChargedCents),
    totalIncludedCents,
    totalIncludedDollars: formatCents(totalIncludedCents),
    totalOnDemandCents,
    totalOnDemandDollars: formatCents(totalOnDemandCents),
    note:
      "includedDollars burns plan/bonus pool; onDemandDollars is pay-as-you-go. chargedDollars is their sum (plus rare other buckets).",
    chats: rows,
  };
}

/** Rank the N most recent local chats by usage, including $0 chats. */
export async function rankRecentChatsByUsage(args: {
  limit?: number;
  startDate?: string;
  endDate?: string;
}) {
  const limit = args.limit ?? 100;
  const { sessions } = listChatSummaries({ limit, offset: 0, includeTotal: true });

  let startDateMs: number;
  let endDateMs: number;
  let source: "billing_cycle" | "custom" | "chat_span";

  if (args.startDate && args.endDate) {
    const range = await resolveUsageDateRange(args);
    startDateMs = range.startDateMs;
    endDateMs = range.endDateMs;
    source = range.source;
  } else {
    // Prefer full billing cycle so included vs on-demand split is complete.
    // (Recent chats often only show on-demand after the included pool is exhausted.)
    const range = await resolveUsageDateRange();
    startDateMs = range.startDateMs;
    endDateMs = range.endDateMs;
    source = range.source;
  }

  const events = await fetchAllUsageEventsInRange({ startDateMs, endDateMs });
  const usageById = new Map(
    aggregateUsageByConversation(events).map((row) => [row.conversationId, row]),
  );

  const rows = sessions
    .map((chat) => {
      const usage = usageById.get(chat.id) ?? emptyTotals(chat.id);
      const [row] = enrichUsageRows([usage], buildChatLookup([chat]));
      return {
        ...row,
        sessionIndex: chat.sessionIndex,
        title: chat.title,
        workspace: chat.workspace,
        chatUpdatedAt: chat.updatedAt,
      };
    })
    .sort((a, b) => b.chargedCents - a.chargedCents || b.onDemandCents - a.onDemandCents);

  const withUsage = rows.filter((row) => row.eventCount > 0);
  const totalChargedCents = withUsage.reduce((sum, row) => sum + row.chargedCents, 0);
  const totalIncludedCents = withUsage.reduce((sum, row) => sum + row.includedCents, 0);
  const totalOnDemandCents = withUsage.reduce((sum, row) => sum + row.onDemandCents, 0);

  return {
    accountNote: "Usage is for the currently logged-in Cursor account only.",
    dateRange: {
      start: new Date(startDateMs).toISOString(),
      end: new Date(endDateMs).toISOString(),
      source,
    },
    chatsReviewed: rows.length,
    chatsWithUsage: withUsage.length,
    totalChargedDollars: formatCents(totalChargedCents),
    totalIncludedDollars: formatCents(totalIncludedCents),
    totalOnDemandDollars: formatCents(totalOnDemandCents),
    note:
      "includedDollars = plan/bonus usage value. onDemandDollars = pay-as-you-go cash-like spend. chargedDollars ≈ included + onDemand (+ rare other).",
    chats: rows,
  };
}

export async function getChatUsage(args: {
  sessionId?: string;
  sessionIndex?: number;
  startDate?: string;
  endDate?: string;
  includeEvents?: boolean;
}) {
  let sessionId = args.sessionId;
  let chat: ChatSummary | undefined;

  if (args.sessionIndex != null) {
    chat = getChatByIndex(args.sessionIndex, { maxMessages: 1 });
    sessionId = chat.id;
  } else if (sessionId) {
    const index = getSessionIndexForId(sessionId);
    if (index != null) {
      chat = getChatByIndex(index, { maxMessages: 1 });
    }
  }

  if (!sessionId) {
    throw new Error("Provide sessionIndex or sessionId.");
  }

  const { startDateMs, endDateMs, source } = await resolveUsageDateRange(args);
  const events = await fetchAllUsageEventsInRange({ startDateMs, endDateMs });
  const aggregated = aggregateUsageByConversation(events, {
    conversationId: sessionId,
    includeEvents: args.includeEvents,
  });

  const usage = aggregated[0];
  if (!usage) {
    return {
      sessionId,
      sessionIndex: chat?.sessionIndex ?? getSessionIndexForId(sessionId),
      title: chat?.title,
      workspace: chat?.workspace,
      dateRange: {
        start: new Date(startDateMs).toISOString(),
        end: new Date(endDateMs).toISOString(),
        source,
      },
      usage: null,
      message: "No usage events found for this chat in the selected date range.",
    };
  }

  const [row] = enrichUsageRows([usage], chat ? buildChatLookup([chat]) : undefined);

  return {
    sessionId,
    sessionIndex: row.sessionIndex ?? chat?.sessionIndex ?? getSessionIndexForId(sessionId),
    title: row.title ?? chat?.title,
    workspace: row.workspace ?? chat?.workspace,
    dateRange: {
      start: new Date(startDateMs).toISOString(),
      end: new Date(endDateMs).toISOString(),
      source,
    },
    usage: row,
  };
}

export function usageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
