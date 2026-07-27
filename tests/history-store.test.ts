import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exportChatMarkdown,
  getChatByIndex,
  getDefaultDataPath,
  listChatSummaries,
  summarizeSessionForPrompt,
  type ChatSession,
} from "../src/history-store.js";

const sampleSession: ChatSession = {
  sessionIndex: 1,
  id: "session-1",
  title: "Sample chat",
  workspace: "/tmp/project",
  workspaceId: "ws-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  messageCount: 2,
  preview: "preview",
  isArchived: false,
  messages: [
    { role: "user", content: "Hello there" },
    {
      role: "assistant",
      content: "Hi!",
      toolCalls: [{ name: "grep", status: "completed" }],
    },
  ],
};

test("exportChatMarkdown renders title, metadata, and tool calls", () => {
  const markdown = exportChatMarkdown(sampleSession);
  assert.match(markdown, /# Sample chat/);
  assert.match(markdown, /Session ID: session-1/);
  assert.match(markdown, /tool: grep \(completed\)/);
});

test("summarizeSessionForPrompt keeps only the latest messages", () => {
  const longSession: ChatSession = {
    ...sampleSession,
    messages: Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    })) as ChatSession["messages"],
  };

  const summary = summarizeSessionForPrompt(longSession, 3);
  assert.match(summary, /message-17/);
  assert.match(summary, /message-18/);
  assert.match(summary, /message-19/);
  assert.doesNotMatch(summary, /message-16/);
});

test("getChatByIndex validates session index", () => {
  assert.throws(() => getChatByIndex(0), /positive integer/);
  assert.throws(() => getChatByIndex(1.5), /positive integer/);
});

test("getChatByIndex throws when session is missing", () => {
  assert.throws(() => getChatByIndex(999_999), /not found/);
});

test("listChatSummaries reads local storage when available", async (t) => {
  try {
    getDefaultDataPath();
  } catch {
    t.skip("Cursor storage unavailable");
    return;
  }

  const page = listChatSummaries({ limit: 1, offset: 0 });
  if (page.total === 0) {
    t.skip("no sessions in local Cursor storage");
    return;
  }

  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0].sessionIndex, 1);

  const filtered = listChatSummaries({
    limit: 5,
    offset: 0,
    workspace: page.sessions[0].workspace.slice(0, 4),
  });
  assert.ok(filtered.sessions.length >= 1);
});
