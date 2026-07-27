import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildActiveSummary,
  buildExperimentRows,
  collectDashboardLiveSnapshot,
  collectDashboardSnapshot,
  collectSpawnThoughts,
  defaultExperimentsDir,
  listLogSources,
  pidAlive,
  readJsonSafe,
  summarizeFleetProductivity,
  tailFile,
} from "../src/dashboard.js";
import { loadBudgetState, saveBudgetState } from "../src/plan-budget.js";
import { appendRunEvent } from "../src/run-events.js";

test("readJsonSafe returns null for missing files", () => {
  assert.equal(readJsonSafe("/tmp/does-not-exist-dashboard.json"), null);
});

test("tailFile returns last lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-tail-"));
  const path = join(dir, "sample.log");
  writeFileSync(path, "a\nb\nc\nd\n");
  assert.equal(tailFile(path, 2), "c\nd");
});

test("listLogSources finds experiment logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-logs-"));
  writeFileSync(join(dir, "orchestrator.log"), "hello\n");
  writeFileSync(join(dir, "manifest.json"), "{}");
  const logs = listLogSources(dir);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.name, "orchestrator");
});

test("buildExperimentRows merges watch checkpoint data", () => {
  const rows = buildExperimentRows(
    [{ name: "worker-dedicated", pid: 42, checkpointPath: "/tmp/x.json" }],
    {
      experiments: [
        {
          name: "worker-dedicated",
          alive: false,
          checkpoint: { exists: true, ticks: 2, stoppedBecause: "error" },
        },
      ],
    },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.alive, false);
  assert.equal(rows[0]?.checkpoint?.ticks, 2);
});

test("buildExperimentRows reads productive metrics from checkpoint files", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-cp-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      startedAt: "2026-07-27T12:00:00.000Z",
      ticks: [
        {
          at: "2026-07-27T12:01:00.000Z",
          outcome: { producedWork: true, committed: true, commits: 1, filesChanged: 1 },
        },
        { at: "2026-07-27T12:02:00.000Z", error: "auth" },
      ],
    }),
  );
  const rows = buildExperimentRows([{ name: "sdk-worker-1", pid: 99_999_999, checkpointPath: path }], null);
  assert.equal(rows[0]?.displayName, "Self-improve worker #1");
  assert.equal(rows[0]?.checkpoint?.exists, true);
  assert.equal(rows[0]?.checkpoint?.ticks, 2);
  assert.equal(rows[0]?.checkpoint?.attemptedTicks, 2);
  assert.equal(rows[0]?.checkpoint?.productiveTicks, 1);
  assert.equal(rows[0]?.checkpoint?.productiveRatio, 0.5);
});

test("buildExperimentRows reads agentId from checkpoint file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-agent-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      agentId: "agent-checkpoint-id",
      ticks: [{ tick: 1, at: "2026-07-27T00:00:00.000Z", watchedMs: 1 }],
    }),
  );
  const rows = buildExperimentRows([{ name: "sdk-worker-1", pid: 1, checkpointPath: path }], null);
  assert.equal(rows[0]?.agentId, "agent-checkpoint-id");
});

test("buildExperimentRows marks corrupt checkpoints as existing", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-bad-cp-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, "{not-json");
  const rows = buildExperimentRows([{ name: "sdk-worker-bad", pid: 1, checkpointPath: path }], null);
  assert.equal(rows[0]?.checkpoint?.exists, true);
  assert.equal(rows[0]?.checkpoint?.ticks, 0);
});

test("pidAlive detects current process", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
});

test("collectDashboardSnapshot reads experiment dir when present", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-meta-"));
  const experimentsDir = defaultExperimentsDir(metaDir);
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(
    join(experimentsDir, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      experiments: [],
      watcherPid: -1,
      strategyReviewerPid: -1,
    }),
  );
  writeFileSync(
    join(experimentsDir, "dedicated-worker.json"),
    JSON.stringify({ sessionId: "dddddddd-dddd-dddd-dddd-dddddddddddd", sessionIndex: 4 }),
  );
  const snapshot = collectDashboardSnapshot({ metaDir, pulseLimit: 3 });
  assert.equal(snapshot.metaDir, metaDir);
  assert.ok(snapshot.budget);
  assert.ok(snapshot.fleetHealth);
  assert.equal(snapshot.fleetHealth.watcherAlive, false);
  assert.equal(snapshot.fleetHealth.strategyReviewerAlive, false);
  assert.equal(snapshot.dedicatedWorker?.sessionIndex, 4);
  assert.ok(snapshot.gitSync);
  assert.ok(snapshot.gitSync.summary);
});

test("collectDashboardSnapshot fleetRuntime uses budget fleetStartedAt not manifest refresh", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-runtime-"));
  const experimentsDir = defaultExperimentsDir(metaDir);
  mkdirSync(experimentsDir, { recursive: true });
  const budgetPath = join(metaDir, "plan-budget.json");
  const fleetStartedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  writeFileSync(
    join(experimentsDir, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      experiments: [],
      watcherPid: -1,
      strategyReviewerPid: -1,
    }),
  );
  saveBudgetState({ ...loadBudgetState(budgetPath), fleetStartedAt }, budgetPath);

  const snapshot = collectDashboardSnapshot({ metaDir, pulseLimit: 3 });
  assert.ok(snapshot.fleetRuntime);
  assert.ok(snapshot.fleetRuntime!.elapsedMs >= 59 * 60_000);
  assert.ok(snapshot.fleetRuntime!.elapsedMs < 65 * 60_000);
});

test("collectDashboardSnapshot marks staleManifest when fleet dead and manifest old", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-stale-"));
  const experimentsDir = defaultExperimentsDir(metaDir);
  mkdirSync(experimentsDir, { recursive: true });
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(
    join(experimentsDir, "manifest.json"),
    JSON.stringify({
      at: staleAt,
      experiments: [{ name: "worker-dedicated", pid: 99_999_999 }],
    }),
  );
  const snapshot = collectDashboardSnapshot({ metaDir, pulseLimit: 3 });
  assert.equal(snapshot.fleetHealth.alive, 0);
  assert.equal(snapshot.fleetHealth.staleManifest, true);
});

test("collectDashboardSnapshot does not mark staleManifest for fresh dead fleet", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-fresh-dead-"));
  const experimentsDir = defaultExperimentsDir(metaDir);
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(
    join(experimentsDir, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      experiments: [{ name: "worker-dedicated", pid: 99_999_999 }],
    }),
  );
  const snapshot = collectDashboardSnapshot({ metaDir, pulseLimit: 3 });
  assert.equal(snapshot.fleetHealth.alive, 0);
  assert.equal(snapshot.fleetHealth.staleManifest, false);
});

test("buildActiveSummary summarizes fleet and worker tails", () => {
  const summary = buildActiveSummary({
    fleetHealth: { total: 2, alive: 2, watcherAlive: true, strategyReviewerAlive: true, manifestAt: null, staleManifest: false },
    manifest: { goal: "Improve tests" },
    budget: { warnings: [] },
    strategyStatus: { onTrack: true, recommendation: "Keep going" },
    pulse: { at: new Date().toISOString(), scanned: 0, live: [], frustrationEvents: [], orchestrationMatrix: [], parallelWorkspaces: [] },
    experiments: [
      {
        name: "worker-a",
        pid: 1,
        alive: true,
        checkpoint: {
          exists: true,
          ticks: 3,
          lastTick: {
            tick: 3,
            at: new Date().toISOString(),
            watchedMs: 100,
            wasAlreadyIdle: true,
            lastAssistantTail: "All tests pass now.",
          },
        },
      },
    ],
    spawnThoughts: [],
  });
  assert.match(summary.headline, /running smoothly|active/i);
  assert.ok(summary.lines.some((line) => /Worker A/i.test(line.text)));
});

test("buildActiveSummary uses friendly labels for worker-session experiments", () => {
  const summary = buildActiveSummary({
    fleetHealth: { total: 1, alive: 1, watcherAlive: false, strategyReviewerAlive: false, manifestAt: null, staleManifest: false },
    manifest: null,
    budget: { warnings: [] },
    strategyStatus: { onTrack: true, recommendation: "Keep going" },
    pulse: { at: new Date().toISOString(), scanned: 0, live: [], frustrationEvents: [], orchestrationMatrix: [], parallelWorkspaces: [] },
    experiments: [
      {
        name: "worker-session-2",
        displayName: "IDE worker #2",
        pid: 1,
        alive: true,
        checkpoint: {
          exists: true,
          ticks: 1,
          lastTick: {
            tick: 1,
            at: new Date().toISOString(),
            watchedMs: 50,
            error: "auth expired",
          },
        },
      },
    ],
    spawnThoughts: [],
  });
  assert.ok(summary.lines.some((line) => /IDE worker #2: auth expired/.test(line.text)));
});

test("buildActiveSummary friendly-labels recent episode actors", () => {
  const agentId = "agent-episode-abc";
  const summary = buildActiveSummary({
    fleetHealth: { total: 1, alive: 1, watcherAlive: false, strategyReviewerAlive: false, manifestAt: null, staleManifest: false },
    manifest: null,
    budget: { warnings: [] },
    strategyStatus: null,
    pulse: { at: new Date().toISOString(), scanned: 0, live: [], frustrationEvents: [], orchestrationMatrix: [], parallelWorkspaces: [] },
    experiments: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        pid: 1,
        alive: true,
        agentId,
        checkpoint: {
          exists: true,
          ticks: 2,
          lastTick: { tick: 2, at: new Date().toISOString(), agentId },
        },
      },
    ],
    recentEpisodes: [
      { id: "ep-1", at: new Date().toISOString(), actor: agentId, action: "commit", outcome: "success" },
    ],
    spawnThoughts: [],
  });
  assert.ok(summary.lines.some((line) => /Self-improve worker #1 · tick 2 · commit · success/.test(line.text)));
});

test("collectSpawnThoughts includes worker tails and live chats", () => {
  const thoughts = collectSpawnThoughts({
    experiments: [
      {
        name: "worker-a",
        pid: 1,
        alive: true,
        checkpoint: {
          exists: true,
          ticks: 1,
          lastTick: {
            tick: 1,
            at: new Date().toISOString(),
            watchedMs: 50,
            wasAlreadyIdle: false,
            lastAssistantTail: "Refactoring dashboard.ts",
          },
        },
      },
    ],
    pulse: {
      at: new Date().toISOString(),
      scanned: 1,
      live: [
        {
          sessionId: "abc",
          sessionIndex: 2,
          title: "Fleet UI",
          workspace: "/tmp",
          signals: ["generating"],
          frustrationRisk: { score: 0, reason: null },
          lastBubble: "Updating styles.css",
        },
      ],
      frustrationEvents: [],
      orchestrationMatrix: [],
      parallelWorkspaces: [],
    },
  });
  assert.ok(thoughts.some((thought) => thought.source === "worker" && thought.text.includes("Refactoring")));
  assert.ok(thoughts.some((thought) => thought.source === "chat" && thought.text.includes("styles.css")));
});

test("collectSpawnThoughts labels sdk runs from worker agent index", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-sdk-thoughts-"));
  const agentId = "agent-aa63128c-95ef-443b-8b99-a8e80203316a";
  appendRunEvent(
    "run-fleet-1",
    { type: "assistant", message: "Committed ground-truth fix." },
    { metaDir, agentId, label: "self-improve-fleet" },
  );

  const thoughts = collectSpawnThoughts({
    metaDir,
    experiments: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        pid: 1,
        alive: true,
        agentId,
        checkpoint: {
          exists: true,
          ticks: 3,
          lastTick: { tick: 3, at: new Date().toISOString(), agentId },
        },
      },
    ],
    pulse: {
      at: new Date().toISOString(),
      scanned: 0,
      live: [],
      frustrationEvents: [],
      orchestrationMatrix: [],
      parallelWorkspaces: [],
    },
  });

  const sdkThought = thoughts.find((thought) => thought.source === "sdk-run");
  assert.ok(sdkThought);
  assert.match(sdkThought?.label ?? "", /Self-improve worker #1 · tick 3/);
  assert.match(sdkThought?.text ?? "", /Committed ground-truth fix/);
});

test("collectSpawnThoughts keeps newest sdk run per agentId", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-sdk-dedupe-"));
  const agentId = "agent-dedupe-12345678";
  appendRunEvent("run-old", { type: "assistant", message: "stale tail" }, { metaDir, agentId });
  const oldPath = join(metaDir, "runs", "run-old.jsonl");
  const oldTime = (Date.now() - 60_000) / 1000;
  utimesSync(oldPath, oldTime, oldTime);

  appendRunEvent("run-new", { type: "assistant", message: "fresh tail" }, { metaDir, agentId });

  const thoughts = collectSpawnThoughts({
    metaDir,
    experiments: [
      {
        name: "sdk-worker-1",
        displayName: "Self-improve worker #1",
        pid: 1,
        alive: true,
        agentId,
        checkpoint: {
          exists: true,
          ticks: 2,
          lastTick: { tick: 2, at: new Date().toISOString(), agentId },
        },
      },
    ],
    pulse: {
      at: new Date().toISOString(),
      scanned: 0,
      live: [],
      frustrationEvents: [],
      orchestrationMatrix: [],
      parallelWorkspaces: [],
    },
  });

  const sdkThoughts = thoughts.filter((thought) => thought.source === "sdk-run");
  assert.equal(sdkThoughts.length, 1);
  assert.match(sdkThoughts[0]?.text ?? "", /fresh tail/);
});

test("collectDashboardLiveSnapshot returns summary and thoughts", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-live-"));
  const experimentsDir = defaultExperimentsDir(metaDir);
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(
    join(experimentsDir, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      experiments: [],
      watcherPid: -1,
      strategyReviewerPid: -1,
    }),
  );
  const live = collectDashboardLiveSnapshot({ metaDir, pulseLimit: 2 });
  assert.ok(live.activeSummary.headline);
  assert.ok(typeof live.activeSummary.overview === "string");
  assert.ok(live.activeSummary.overview.length > 0);
  assert.ok(Array.isArray(live.spawnThoughts));
  assert.ok(Array.isArray(live.workerActivity));
  assert.ok(live.fleetHealth);
  assert.ok(live.worldModel);
});

test("collectDashboardLiveSnapshot reports sdk worker error despite recent live events", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dashboard-error-live-"));
  const experimentsDir = defaultExperimentsDir(metaDir);
  mkdirSync(experimentsDir, { recursive: true });
  const checkpointPath = join(experimentsDir, "sdk-worker-1.json");
  const agentId = "agent-error-live";
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      startedAt: new Date().toISOString(),
      agentId,
      ticks: [{ tick: 3, at: new Date().toISOString(), watchedMs: 100, error: "Agent transport dropped" }],
    }),
  );
  appendRunEvent(
    "run-error-live",
    { type: "thinking", message: "Still streaming after failure" },
    { metaDir, agentId, label: "self-improve-fleet" },
  );
  writeFileSync(
    join(experimentsDir, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      experiments: [
        {
          name: "sdk-worker-1",
          pid: process.pid,
          checkpointPath,
          logPath: join(experimentsDir, "sdk-worker-1.log"),
        },
      ],
      watcherPid: -1,
      strategyReviewerPid: -1,
    }),
  );

  const live = collectDashboardLiveSnapshot({ metaDir, pulseLimit: 2 });
  assert.equal(live.activeSummary.status, "bad");
  assert.match(live.activeSummary.headline, /hit an error/i);
  assert.match(live.activeSummary.overview, /Agent transport dropped/i);
  assert.equal(live.workerActivity[0]?.status, "error");
});

test("buildActiveSummary warns when productive gate fails on attempted ticks", () => {
  const summary = buildActiveSummary({
    fleetHealth: { total: 1, alive: 1, watcherAlive: true, strategyReviewerAlive: false, manifestAt: null, staleManifest: false },
    manifest: null,
    budget: { warnings: [] },
    strategyStatus: null,
    pulse: { at: new Date().toISOString(), scanned: 0, live: [], frustrationEvents: [], orchestrationMatrix: [], parallelWorkspaces: [] },
    experiments: [
      {
        name: "sdk-worker-1",
        pid: 1,
        alive: true,
        checkpoint: {
          exists: true,
          ticks: 8,
          productiveTicks: 1,
          productiveRatio: 0.2,
          metrics: {
            ticks: 8,
            productiveTicks: 1,
            productiveRatio: 0.2,
            commits: 1,
            filesChanged: 1,
            errors: 2,
            softSkips: 3,
            testFailures: 0,
            lastCommitted: false,
          },
        },
      },
    ],
    spawnThoughts: [],
  });
  assert.ok(
    summary.lines.some((line) => line.level === "warn" && /productive 20% below 30% gate \(1\/5 attempted\)/.test(line.text)),
  );
});

test("buildActiveSummary skips productive warn when soft skips leave too few attempts", () => {
  const summary = buildActiveSummary({
    fleetHealth: { total: 1, alive: 1, watcherAlive: true, strategyReviewerAlive: false, manifestAt: null, staleManifest: false },
    manifest: null,
    budget: { warnings: [] },
    strategyStatus: null,
    pulse: { at: new Date().toISOString(), scanned: 0, live: [], frustrationEvents: [], orchestrationMatrix: [], parallelWorkspaces: [] },
    experiments: [
      {
        name: "worker-busy",
        pid: 2,
        alive: true,
        checkpoint: {
          exists: true,
          ticks: 6,
          productiveTicks: 0,
          productiveRatio: 0,
          metrics: {
            ticks: 6,
            productiveTicks: 0,
            productiveRatio: 0,
            commits: 0,
            filesChanged: 0,
            errors: 0,
            softSkips: 5,
            testFailures: 0,
            lastCommitted: false,
          },
          lastTick: {
            tick: 6,
            at: new Date().toISOString(),
            watchedMs: 10,
            wasAlreadyIdle: false,
            skipped: "busy",
          },
        },
      },
    ],
    spawnThoughts: [],
  });
  assert.equal(
    summary.lines.some((line) => line.level === "warn" && /productive/.test(line.text)),
    false,
  );
  assert.ok(summary.lines.some((line) => /waiting for chat/.test(line.text)));
});

test("summarizeFleetProductivity aggregates worker checkpoints", () => {
  const productivity = summarizeFleetProductivity([
    {
      name: "sdk-worker-1",
      pid: 1,
      alive: true,
      checkpoint: {
        exists: true,
        ticks: 2,
        productiveTicks: 1,
        productiveRatio: 0.5,
        metrics: {
          ticks: 2,
          productiveTicks: 1,
          productiveRatio: 0.5,
          commits: 1,
          filesChanged: 1,
          errors: 0,
          softSkips: 0,
          testFailures: 0,
          lastCommitted: true,
        },
      },
    },
    {
      name: "strategy-review-loop",
      pid: 2,
      alive: true,
    },
  ]);
  assert.ok(productivity);
  assert.equal(productivity?.totalTicks, 2);
  assert.equal(productivity?.attemptedTicks, 2);
  assert.equal(productivity?.productiveTicks, 1);
  assert.equal(productivity?.productiveRatio, 0.5);
  assert.equal(productivity?.meetsGate, false);
});

test("summarizeFleetProductivity excludes soft skips from attempted ratio", () => {
  const productivity = summarizeFleetProductivity([
    {
      name: "worker-a",
      pid: 1,
      alive: true,
      checkpoint: {
        exists: true,
        ticks: 5,
        productiveTicks: 2,
        productiveRatio: 1,
        metrics: {
          ticks: 5,
          productiveTicks: 2,
          productiveRatio: 1,
          commits: 2,
          filesChanged: 2,
          errors: 0,
          softSkips: 3,
          testFailures: 0,
          lastCommitted: true,
        },
      },
    },
  ]);
  assert.ok(productivity);
  assert.equal(productivity?.totalTicks, 5);
  assert.equal(productivity?.attemptedTicks, 2);
  assert.equal(productivity?.productiveRatio, 1);
  assert.equal(productivity?.meetsGate, false); // only 2 attempted < minTicks 3
});
