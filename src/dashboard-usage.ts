import { readCursorAccessToken } from "./cursor-auth.js";

const DASHBOARD_RPC_BASE = "https://api2.cursor.sh";

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCents?: number;
}

export type UsageBillingBucket =
  | "included"
  | "on_demand"
  | "free_credit"
  | "not_charged"
  | "other";

export interface UsageEventDisplay {
  timestamp: string;
  model: string;
  kind: string;
  chargedCents: number;
  conversationId?: string;
  tokenUsage?: TokenUsageBreakdown;
  isHeadless?: boolean;
  requestsCosts?: number;
  usageBasedCosts?: string;
  isChargeable?: boolean;
}

/** Classify a usage event into billing bucket (included pool vs pay-as-you-go). */
export function classifyUsageEvent(event: UsageEventDisplay): UsageBillingBucket {
  const kind = (event.kind || "").toUpperCase();
  if (kind.includes("USAGE_BASED") || kind.includes("ON_DEMAND")) return "on_demand";
  if (kind.includes("INCLUDED")) return "included";
  if (kind.includes("FREE_CREDIT") || kind.includes("BONUS")) return "free_credit";
  if (kind.includes("ERRORED") || kind.includes("NOT_CHARGED")) return "not_charged";

  const usageBased = String(event.usageBasedCosts || "").trim();
  if (usageBased.startsWith("$") && usageBased !== "$0.00" && usageBased !== "-") {
    return "on_demand";
  }
  return "other";
}

export interface PeriodUsageSummary {
  billingCycleStart: string;
  billingCycleEnd: string;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    limit?: number;
    totalPercentUsed?: number;
  };
  displayMessage?: string;
}

export interface ConversationUsageTotals {
  conversationId: string;
  eventCount: number;
  /** Sum of chargedCents across all events (included + on-demand + other). */
  chargedCents: number;
  /** Usage value against included plan pool (not necessarily cash). */
  includedCents: number;
  /** Pay-as-you-go / usage-based spend. */
  onDemandCents: number;
  freeCreditCents: number;
  notChargedCents: number;
  otherCents: number;
  includedEventCount: number;
  onDemandEventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: string[];
  firstEventAt: string | null;
  lastEventAt: string | null;
  events?: UsageEventDisplay[];
}

type FetchFn = typeof fetch;

function requireAccessToken(): string {
  const token = readCursorAccessToken();
  if (!token) {
    throw new Error(
      "Cursor IDE session token not found. Log in to Cursor locally (cursorAuth/accessToken in state.vscdb).",
    );
  }
  return token;
}

async function dashboardRpc<T>(
  method: string,
  body: Record<string, unknown>,
  options?: { fetchImpl?: FetchFn; accessToken?: string },
): Promise<T> {
  const token = options?.accessToken ?? requireAccessToken();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DASHBOARD_RPC_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Cursor dashboard API ${method} failed (${response.status}): ${text.slice(0, 400)}`);
  }

  return JSON.parse(text) as T;
}

export async function fetchCurrentPeriodUsage(options?: {
  fetchImpl?: FetchFn;
  accessToken?: string;
}): Promise<PeriodUsageSummary> {
  return dashboardRpc<PeriodUsageSummary>(
    "aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {},
    options,
  );
}

export async function fetchFilteredUsageEvents(args: {
  startDateMs: number;
  endDateMs: number;
  page?: number;
  pageSize?: number;
  fetchImpl?: FetchFn;
  accessToken?: string;
}): Promise<{ totalUsageEventsCount: number; usageEventsDisplay: UsageEventDisplay[] }> {
  return dashboardRpc(
    "aiserver.v1.DashboardService/GetFilteredUsageEvents",
    {
      start_date: String(args.startDateMs),
      end_date: String(args.endDateMs),
      page: args.page ?? 1,
      page_size: args.pageSize ?? 100,
    },
    { fetchImpl: args.fetchImpl, accessToken: args.accessToken },
  );
}

export async function fetchAllUsageEventsInRange(args: {
  startDateMs: number;
  endDateMs: number;
  pageSize?: number;
  fetchImpl?: FetchFn;
  accessToken?: string;
}): Promise<UsageEventDisplay[]> {
  const pageSize = args.pageSize ?? 100;
  const fetchImpl = args.fetchImpl;
  const accessToken = args.accessToken;
  const all: UsageEventDisplay[] = [];
  let page = 1;

  while (true) {
    const response = await fetchFilteredUsageEvents({
      startDateMs: args.startDateMs,
      endDateMs: args.endDateMs,
      page,
      pageSize,
      fetchImpl,
      accessToken,
    });
    all.push(...response.usageEventsDisplay);
    if (
      response.usageEventsDisplay.length < pageSize ||
      all.length >= response.totalUsageEventsCount
    ) {
      break;
    }
    page += 1;
  }

  return all;
}

export function aggregateUsageByConversation(
  events: UsageEventDisplay[],
  options?: { conversationId?: string; includeEvents?: boolean },
): ConversationUsageTotals[] {
  const byId = new Map<string, ConversationUsageTotals>();

  for (const event of events) {
    const conversationId = event.conversationId?.trim();
    if (!conversationId) continue;
    if (options?.conversationId && conversationId !== options.conversationId) continue;

    let totals = byId.get(conversationId);
    if (!totals) {
      totals = {
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
        events: options?.includeEvents ? [] : undefined,
      };
      byId.set(conversationId, totals);
    }

    const cents = event.chargedCents ?? 0;
    const bucket = classifyUsageEvent(event);

    totals.eventCount += 1;
    totals.chargedCents += cents;
    if (bucket === "included") {
      totals.includedCents += cents;
      totals.includedEventCount += 1;
    } else if (bucket === "on_demand") {
      totals.onDemandCents += cents;
      totals.onDemandEventCount += 1;
    } else if (bucket === "free_credit") {
      totals.freeCreditCents += cents;
    } else if (bucket === "not_charged") {
      totals.notChargedCents += cents;
    } else {
      totals.otherCents += cents;
    }

    totals.inputTokens += event.tokenUsage?.inputTokens ?? 0;
    totals.outputTokens += event.tokenUsage?.outputTokens ?? 0;
    totals.cacheReadTokens += event.tokenUsage?.cacheReadTokens ?? 0;

    if (event.model && !totals.models.includes(event.model)) {
      totals.models.push(event.model);
    }

    const ts = event.timestamp;
    if (ts) {
      if (!totals.firstEventAt || ts < totals.firstEventAt) totals.firstEventAt = ts;
      if (!totals.lastEventAt || ts > totals.lastEventAt) totals.lastEventAt = ts;
    }

    if (options?.includeEvents && totals.events) {
      totals.events.push(event);
    }
  }

  return [...byId.values()].sort((a, b) => b.chargedCents - a.chargedCents);
}

export async function resolveUsageDateRange(args?: {
  startDate?: string;
  endDate?: string;
  fetchImpl?: FetchFn;
  accessToken?: string;
}): Promise<{ startDateMs: number; endDateMs: number; source: "billing_cycle" | "custom" }> {
  if (args?.startDate && args?.endDate) {
    const startDateMs = Date.parse(args.startDate);
    const endDateMs = Date.parse(args.endDate);
    if (Number.isNaN(startDateMs) || Number.isNaN(endDateMs)) {
      throw new Error("startDate and endDate must be valid ISO date strings.");
    }
    if (endDateMs <= startDateMs) {
      throw new Error("endDate must be after startDate.");
    }
    return { startDateMs, endDateMs, source: "custom" };
  }

  const period = await fetchCurrentPeriodUsage({
    fetchImpl: args?.fetchImpl,
    accessToken: args?.accessToken,
  });
  const startDateMs = Number(period.billingCycleStart);
  const endDateMs = Number(period.billingCycleEnd);
  if (!Number.isFinite(startDateMs) || !Number.isFinite(endDateMs)) {
    throw new Error("Could not resolve billing cycle dates from Cursor dashboard.");
  }
  return { startDateMs, endDateMs, source: "billing_cycle" };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
