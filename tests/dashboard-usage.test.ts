import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateUsageByConversation,
  fetchAllUsageEventsInRange,
  formatCents,
  resolveUsageDateRange,
} from "../src/dashboard-usage.js";

test("aggregateUsageByConversation sums tokens and costs per conversationId", () => {
  const events = [
    {
      timestamp: "1000",
      model: "composer-2.5",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
      chargedCents: 10,
      conversationId: "chat-a",
      tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 },
    },
    {
      timestamp: "2000",
      model: "composer-2.5-fast",
      kind: "USAGE_EVENT_KIND_USAGE_BASED",
      chargedCents: 5,
      conversationId: "chat-a",
      tokenUsage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 30 },
    },
    {
      timestamp: "1500",
      model: "gpt-5",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_ULTRA",
      chargedCents: 3,
      conversationId: "chat-b",
      tokenUsage: { inputTokens: 5, outputTokens: 2 },
    },
  ];

  const totals = aggregateUsageByConversation(events);
  assert.equal(totals.length, 2);
  assert.equal(totals[0].conversationId, "chat-a");
  assert.equal(totals[0].chargedCents, 15);
  assert.equal(totals[0].includedCents, 10);
  assert.equal(totals[0].onDemandCents, 5);
  assert.equal(totals[0].includedEventCount, 1);
  assert.equal(totals[0].onDemandEventCount, 1);
  assert.equal(totals[0].inputTokens, 120);
  assert.equal(totals[0].outputTokens, 60);
  assert.equal(totals[0].cacheReadTokens, 230);
  assert.deepEqual(totals[0].models.sort(), ["composer-2.5", "composer-2.5-fast"]);
  assert.equal(totals[1].includedCents, 3);
  assert.equal(totals[1].onDemandCents, 0);
});

test("classifyUsageEvent maps known kinds", async () => {
  const { classifyUsageEvent } = await import("../src/dashboard-usage.js");
  assert.equal(
    classifyUsageEvent({
      timestamp: "1",
      model: "m",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_ULTRA",
      chargedCents: 1,
    }),
    "included",
  );
  assert.equal(
    classifyUsageEvent({
      timestamp: "1",
      model: "m",
      kind: "USAGE_EVENT_KIND_USAGE_BASED",
      chargedCents: 1,
    }),
    "on_demand",
  );
  assert.equal(
    classifyUsageEvent({
      timestamp: "1",
      model: "m",
      kind: "USAGE_EVENT_KIND_FREE_CREDIT",
      chargedCents: 0,
    }),
    "free_credit",
  );
});

test("aggregateUsageByConversation can filter to one conversation and include events", () => {
  const events = [
    {
      timestamp: "1000",
      model: "composer-2.5",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
      chargedCents: 10,
      conversationId: "chat-a",
    },
    {
      timestamp: "2000",
      model: "composer-2.5",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
      chargedCents: 5,
      conversationId: "chat-b",
    },
  ];

  const totals = aggregateUsageByConversation(events, {
    conversationId: "chat-a",
    includeEvents: true,
  });
  assert.equal(totals.length, 1);
  assert.equal(totals[0].eventCount, 1);
  assert.equal(totals[0].events?.length, 1);
});

test("formatCents renders dollar strings", () => {
  assert.equal(formatCents(126.1765), "$1.26");
  assert.equal(formatCents(0), "$0.00");
});

test("resolveUsageDateRange uses custom ISO dates when provided", async () => {
  const range = await resolveUsageDateRange({
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-08-06T00:00:00.000Z",
    fetchImpl: async () => {
      throw new Error("should not call dashboard");
    },
  });
  assert.equal(range.source, "custom");
  assert.equal(range.startDateMs, Date.parse("2026-08-01T00:00:00.000Z"));
});

test("fetchAllUsageEventsInRange paginates until complete", async () => {
  const calls: number[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { page: number };
    calls.push(body.page);
    const usageEventsDisplay =
      body.page === 1
        ? [{ timestamp: "1", model: "m", kind: "k", chargedCents: 1, conversationId: "a" }]
        : [{ timestamp: "2", model: "m", kind: "k", chargedCents: 2, conversationId: "b" }];
    return new Response(
      JSON.stringify({
        totalUsageEventsCount: 2,
        usageEventsDisplay,
      }),
      { status: 200 },
    );
  };

  const events = await fetchAllUsageEventsInRange({
    startDateMs: 1,
    endDateMs: 2,
    pageSize: 1,
    fetchImpl,
    accessToken: "test-token",
  });
  assert.equal(events.length, 2);
  assert.deepEqual(calls, [1, 2]);
});

test("resolveUsageDateRange falls back to billing cycle", async () => {
  const range = await resolveUsageDateRange({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          billingCycleStart: "1000",
          billingCycleEnd: "2000",
        }),
        { status: 200 },
      ),
    accessToken: "test-token",
  });
  assert.equal(range.source, "billing_cycle");
  assert.equal(range.startDateMs, 1000);
  assert.equal(range.endDateMs, 2000);
});
