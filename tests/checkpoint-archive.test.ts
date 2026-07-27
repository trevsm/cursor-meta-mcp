import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  archiveWorkerCheckpointIfNeeded,
  formatArchivedSessionSummary,
  listArchivedWorkerSessions,
} = await import("../src/checkpoint-archive.js");

test("archiveWorkerCheckpointIfNeeded copies completed sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-archive-"));
  const path = join(dir, "sdk-worker-1.json");
  writeFileSync(
    path,
    JSON.stringify({
      startedAt: "2026-07-27T15:52:11.602Z",
      stoppedBecause: "duration",
      ticks: [
        {
          tick: 1,
          at: "2026-07-27T16:00:00.000Z",
          outcome: { producedWork: true, committed: true, commits: 1, filesChanged: 1 },
        },
      ],
    }),
  );

  const archivePath = archiveWorkerCheckpointIfNeeded(path);
  assert.ok(archivePath);
  assert.ok(existsSync(archivePath!));
  assert.notEqual(archivePath, path);
  assert.deepEqual(JSON.parse(readFileSync(archivePath!, "utf8")).stoppedBecause, "duration");

  const again = archiveWorkerCheckpointIfNeeded(path);
  assert.equal(again, archivePath);
});

test("archiveWorkerCheckpointIfNeeded skips empty checkpoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-archive-empty-"));
  const path = join(dir, "sdk-worker-1.json");
  writeFileSync(path, JSON.stringify({ startedAt: new Date().toISOString(), ticks: [] }));
  assert.equal(archiveWorkerCheckpointIfNeeded(path), null);
});

test("listArchivedWorkerSessions returns newest archives first", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-archive-list-"));
  const path = join(dir, "sdk-worker-1.json");
  const older = join(dir, "sdk-worker-1.session-2026-07-27T10-00-00-000Z.json");
  const newer = join(dir, "sdk-worker-1.session-2026-07-27T12-00-00-000Z.json");
  const body = JSON.stringify({
    startedAt: "2026-07-27T12:00:00.000Z",
    stoppedBecause: "duration",
    ticks: [{ tick: 1, outcome: { producedWork: true, commits: 1, filesChanged: 1 } }],
  });
  writeFileSync(older, body);
  writeFileSync(newer, body);
  writeFileSync(path, "{}");

  const rows = listArchivedWorkerSessions(path, 2);
  assert.equal(rows.length, 2);
  assert.match(formatArchivedSessionSummary(rows[0]!), /1 ticks/);
});
