import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";

const launchSelfImproveFleet = mock.fn(async () => ({
  at: new Date().toISOString(),
  root: "/repo",
  goal: "Build checkout",
  conductorExcluded: [1],
  dedicatedWorker: { sessionId: "s", sessionIndex: 1 },
  experiments: [],
  manifestPath: "/tmp/manifest.json",
}));

mock.module("../src/fleet-preflight.js", {
  namedExports: {
    runFleetPreflight: async () => ({
      ok: true,
      failures: [],
      warnings: [],
      auth: { apiKey: true, sdk: true, cli: true },
    }),
  },
});
mock.module("../src/self-improve.js", {
  namedExports: { launchSelfImproveFleet },
});
mock.module("../src/world-model.js", {
  namedExports: { setNorthStar: mock.fn(), pushGoal: mock.fn() },
});

const { writeActiveAgiSession } = await import("../src/agi-mission.js");
const {
  adaptAgiMission,
  diagnoseAgiSnags,
  proposeAgiAdaptations,
  sessionArchitecture,
} = await import("../src/agi-adaptation.js");
const { DEFAULT_AGI_ARCHITECTURE } = await import("../src/agi-architecture.js");

test("proposeAgiAdaptations disables orchestrator on meta loops", () => {
  const session = {
    cwd: "/Users/me/Projects/app",
    task: "Ship feature",
    projectSlug: "app-abc",
    projectMetaDir: "/tmp/meta",
    experimentsDir: "/tmp/meta/experiments",
    workspace: "app",
    startedAt: new Date().toISOString(),
    sessionId: "00000000-0000-4000-8000-000000000010",
    runId: "00000000-0000-4000-8000-000000000011",
  };
  const diagnosed = {
    at: new Date().toISOString(),
    cwd: session.cwd,
    onTrack: false,
    score: 40,
    issues: ["meta_discussion_loop"],
    recommendation: "intercept",
    pivot: "Implement one file change",
    infraSignals: [],
  };
  const proposals = proposeAgiAdaptations(session, diagnosed, DEFAULT_AGI_ARCHITECTURE);
  assert.ok(proposals.some((p) => p.id === "disable_orchestrator"));
});

test("diagnoseAgiSnags reads strategy and watcher signals", () => {
  process.env.CURSOR_META_HOME = join("/tmp", `agi-adapt-${Date.now()}`);
  const experimentsDir = join(process.env.CURSOR_META_HOME, "projects", "app-x", "experiments");
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(
    join(experimentsDir, "strategy-status.json"),
    JSON.stringify({ onTrack: false, score: 35, issues: ["stale_workers"], pivot: "Relaunch worker" }),
  );
  writeFileSync(
    join(experimentsDir, "watch-status.json"),
    JSON.stringify({ relaunchBlocked: true, relaunchBlockedReason: "budget_cap" }),
  );

  const session = {
    cwd: "/Users/me/Projects/app",
    task: "Ship feature",
    projectSlug: "app-x",
    projectMetaDir: join(process.env.CURSOR_META_HOME, "projects", "app-x"),
    experimentsDir,
    workspace: "app",
    startedAt: new Date().toISOString(),
    sessionId: "00000000-0000-4000-8000-000000000012",
    runId: "00000000-0000-4000-8000-000000000013",
  };
  writeActiveAgiSession(session);

  const report = diagnoseAgiSnags(session);
  assert.deepEqual(report.issues, ["stale_workers"]);
  assert.ok(report.infraSignals.includes("budget_cap"));
});

test("adaptAgiMission applies auto proposals and relaunches", async () => {
  process.env.CURSOR_META_HOME = join("/tmp", `agi-adapt-run-${Date.now()}`);
  const projectMetaDir = join(process.env.CURSOR_META_HOME, "projects", "app-y");
  const experimentsDir = join(projectMetaDir, "experiments");
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(
    join(experimentsDir, "strategy-status.json"),
    JSON.stringify({
      onTrack: false,
      issues: ["architecture_theater"],
      pivot: "Ship one test",
    }),
  );

  writeActiveAgiSession({
    cwd: "/Users/me/Projects/app",
    task: "Build API",
    projectSlug: "app-y",
    projectMetaDir,
    experimentsDir,
    workspace: "app",
    startedAt: new Date().toISOString(),
    sessionId: "00000000-0000-4000-8000-000000000020",
    runId: "00000000-0000-4000-8000-000000000021",
    architecture: DEFAULT_AGI_ARCHITECTURE,
  });

  launchSelfImproveFleet.mock.resetCalls();
  const result = await adaptAgiMission({ auto: true });
  assert.equal(result.ok, true);
  assert.ok(result.applied.length > 0);
  assert.equal(result.relaunched, true);
  assert.equal(launchSelfImproveFleet.mock.callCount(), 1);
  const arch = sessionArchitecture(result.session);
  assert.equal(arch.withOrchestrator, false);
});
