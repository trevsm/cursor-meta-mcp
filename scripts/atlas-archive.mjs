#!/usr/bin/env node
import { archiveSessionBubbles } from "../dist/atlas-bubble-archive.js";
import { readAtlasIndex } from "../dist/atlas-index.js";
import { listActiveChats } from "../dist/chat-activity.js";

const limit = Number(process.argv[2] ?? 40);
const index = await readAtlasIndex();
const includeSessionIds = index?.sessions.map((s) => s.id) ?? [];
const active = listActiveChats({
  limit,
  withinMs: 7 * 24 * 60 * 60 * 1000,
  includeSessionIds,
  maxScan: Math.max(limit * 8, 80),
});
const ids = [...new Set([...active.map((a) => a.sessionId), ...includeSessionIds.slice(0, limit)])];
let total = 0;
for (const sessionId of ids) {
  try {
    const result = archiveSessionBubbles(sessionId);
    total += result.archived;
    console.error(`${sessionId.slice(0, 8)}… archived ${result.archived} bubbles (${result.versions} versions)`);
  } catch (err) {
    console.error(`${sessionId.slice(0, 8)}… skipped: ${err}`);
  }
}
console.error(`Done. ${ids.length} sessions, ${total} bubble rows updated.`);
