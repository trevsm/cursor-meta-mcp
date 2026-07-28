import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
      warnings: ["budget soft warning"],
      auth: { apiKey: true, sdk: true, cli: true },
    }),
  },
});
const {
  buildAgiWorkerPrompt,
  launchAgiMission,
  readActiveAgiSession,
} = await import("../src/agi-mission.js");

test("buildAgiWorkerPrompt centers the user task", () => {
  const prompt = buildAgiWorkerPrompt("Add OAuth login");
  assert.match(prompt, /Mission: Add OAuth login/);
  assert.match(prompt, /fully complete/);
});

test("launchAgiMission persists active session and launches fleet", async () => {
  process.env.CURSOR_META_HOME = join("/tmp", `agi-mission-${Date.now()}`);
  launchSelfImproveFleet.mock.resetCalls();

  const result = await launchAgiMission(
    {
      cwd: "/Users/me/Projects/storefront",
      task: "Build checkout flow with tests",
    },
    launchSelfImproveFleet,
  );

  assert.equal(result.ok, true);
  assert.equal(result.session.task, "Build checkout flow with tests");
  assert.match(result.dashboardCommand, /--cwd/);
  assert.equal(launchSelfImproveFleet.mock.callCount(), 1);

  const fleetParams = launchSelfImproveFleet.mock.calls[0]?.arguments[0] as {
    goal: string;
    prompt: string;
    cwd: string;
    useOrbit: boolean;
    orbitMetaDir: string;
  };
  assert.equal(fleetParams.goal, "Build checkout flow with tests");
  assert.match(fleetParams.prompt, /Mission: Build checkout flow with tests/);
  assert.equal(fleetParams.cwd, "/Users/me/Projects/storefront");
  assert.equal(fleetParams.useOrbit, true);
  assert.equal(fleetParams.orbitMetaDir, result.session.projectMetaDir);

  const active = readActiveAgiSession();
  assert.equal(active?.task, "Build checkout flow with tests");
  assert.ok(existsSync(join(process.env.CURSOR_META_HOME!, "active-agi.json")));
  assert.ok(
    existsSync(
      join(process.env.CURSOR_META_HOME!, "projects", active!.projectSlug, "mission.json"),
    ),
  );
});

test("launchAgiMission rejects empty task", async () => {
  await assert.rejects(
    () => launchAgiMission({ cwd: "/repo", task: "   " }, launchSelfImproveFleet),
    /task is required/,
  );
});
