import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  appendExperimentLog,
  formatStrategyLogLine,
  formatWatchLogLine,
} = await import("../src/experiment-log.js");

test("appendExperimentLog trims oldest lines when file exceeds maxBytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "experiment-log-"));
  const path = join(dir, "watch.log");
  for (let i = 0; i < 200; i++) {
    appendExperimentLog(path, `line-${i}-${"x".repeat(80)}`, { maxBytes: 4096, keepLines: 20 });
  }
  const text = readFileSync(path, "utf8");
  const lines = text.trim().split("\n");
  assert.ok(lines.length <= 20);
  assert.ok(statSync(path).size <= 4096);
  assert.match(lines.at(-1) ?? "", /^line-199-/);
});

test("formatWatchLogLine summarizes patrol snapshot compactly", () => {
  const line = formatWatchLogLine({
    at: "2026-07-27T17:00:00.000Z",
    budget: { status: "warn", warnings: ["Fleet max duration exceeded (125m)"] },
    experiments: [
      { name: "sdk-worker-1", alive: true, checkpoint: { ticks: 12 } },
      { name: "strategy-review-loop", alive: true },
    ],
  });
  assert.match(line, /alive=2\/2/);
  assert.match(line, /sdk-worker-1=12t/);
  assert.match(line, /Fleet max duration exceeded/);
});

test("formatStrategyLogLine keeps one readable line", () => {
  const line = formatStrategyLogLine({
    at: "2026-07-27T17:00:00.000Z",
    onTrack: false,
    score: 65,
    issues: ["no_code_progress"],
    recommendation: "Push local commits to origin before starting new work.",
    actions: [],
  });
  assert.match(line, /onTrack=false score=65/);
  assert.match(line, /Push local commits/);
});
