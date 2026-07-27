import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import {
  abortIdeChatInStorage,
  getChatActivity,
  getChatActivityByIndex,
  listActiveChats,
  waitForChatSession,
} from "../src/chat-activity.js";

let tempDir: string | undefined;
let previousDbPath: string | undefined;

function seedTestDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), "cursor-meta-activity-"));
  const dbPath = join(tempDir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      value TEXT,
      isSubagent INTEGER
    );
    CREATE TABLE cursorDiskKV (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const header = {
    name: "Active test chat",
    hasBlockingPendingActions: true,
  };
  const composerData = {
    status: "running",
    generatingBubbleIds: ["bubble-1"],
  };
  const bubble = JSON.stringify({
    type: 2,
    text: "",
    createdAt: new Date().toISOString(),
    toolFormerData: { name: "grep", status: "loading" },
  });

  db.prepare(
    `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, value, isSubagent)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run("11111111-1111-1111-1111-111111111111", "ws-1", Date.now(), Date.now(), JSON.stringify(header));
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    "composerData:11111111-1111-1111-1111-111111111111",
    JSON.stringify(composerData),
  );
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    "bubbleId:11111111-1111-1111-1111-111111111111:1",
    bubble,
  );
  db.close();
  return dbPath;
}

afterEach(() => {
  process.env.CURSOR_META_STATE_DB = previousDbPath;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

test("getChatActivity reports active signals from composer state", () => {
  previousDbPath = process.env.CURSOR_META_STATE_DB;
  process.env.CURSOR_META_STATE_DB = seedTestDb();

  const activity = getChatActivity("11111111-1111-1111-1111-111111111111");
  assert.equal(activity.activityLevel, "active");
  assert.equal(activity.loadingToolCount, 1);
  assert.equal(activity.generatingBubbleCount, 1);
  assert.match(activity.signals.join(","), /blocking_pending_actions/);
});

test("getChatActivityByIndex resolves the first recent session", () => {
  previousDbPath = process.env.CURSOR_META_STATE_DB;
  process.env.CURSOR_META_STATE_DB = seedTestDb();

  const activity = getChatActivityByIndex(1);
  assert.equal(activity.sessionId, "11111111-1111-1111-1111-111111111111");
});

test("listActiveChats returns recent sessions", () => {
  previousDbPath = process.env.CURSOR_META_STATE_DB;
  process.env.CURSOR_META_STATE_DB = seedTestDb();

  const sessions = listActiveChats({ limit: 5 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.activityLevel, "active");
});

test("abortIdeChatInStorage marks composer state aborted", () => {
  previousDbPath = process.env.CURSOR_META_STATE_DB;
  const dbPath = seedTestDb();
  process.env.CURSOR_META_STATE_DB = dbPath;

  const result = abortIdeChatInStorage("11111111-1111-1111-1111-111111111111");
  assert.equal(result.aborted, true);
  assert.equal(result.previousStatus, "running");

  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
    .get("composerData:11111111-1111-1111-1111-111111111111") as { value: string };
  const parsed = JSON.parse(row.value) as { status?: string; generatingBubbleIds?: string[] };
  assert.equal(parsed.status, "aborted");
  assert.deepEqual(parsed.generatingBubbleIds, []);
  db.close();
});

test("waitForChatSession resolves when session exists", async () => {
  previousDbPath = process.env.CURSOR_META_STATE_DB;
  process.env.CURSOR_META_STATE_DB = seedTestDb();
  await waitForChatSession("11111111-1111-1111-1111-111111111111", { timeoutMs: 1000 });
});

test("waitForChatSession times out for missing session", async () => {
  previousDbPath = process.env.CURSOR_META_STATE_DB;
  process.env.CURSOR_META_STATE_DB = seedTestDb();
  await assert.rejects(
    () => waitForChatSession("99999999-9999-9999-9999-999999999999", { timeoutMs: 200, pollMs: 50 }),
    /not found after 200ms/,
  );
});
