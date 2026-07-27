import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendRunEvent,
  listRunEventSources,
  tailRunEvents,
} from "../src/run-events.js";

test("appendRunEvent and tailRunEvents round-trip", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "run-events-"));
  appendRunEvent("run-abc", { type: "thinking", message: "Planning refactor" }, { metaDir, agentId: "agent-1" });
  appendRunEvent("run-abc", { type: "assistant", message: "Done." }, { metaDir, agentId: "agent-1" });
  const events = tailRunEvents("run-abc", { metaDir });
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "thinking");
  assert.equal(events[1]?.message, "Done.");
  assert.equal(events[0]?.agentId, "agent-1");

  const sources = listRunEventSources(metaDir);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.runId, "run-abc");
});

test("tailRunEvents filters by since", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "run-events-since-"));
  appendRunEvent("run-1", { type: "status", message: "old" }, { metaDir });
  const filtered = tailRunEvents("run-1", { metaDir, since: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(filtered.length, 0);
  appendRunEvent("run-1", { type: "status", message: "new" }, { metaDir });
  const all = tailRunEvents("run-1", { metaDir });
  assert.ok(all.some((event) => event.message === "new"));
});
