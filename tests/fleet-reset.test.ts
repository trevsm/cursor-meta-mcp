import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { wipeFleetDashboardState } = await import("../src/fleet-reset.js");

test("wipeFleetDashboardState clears logs, checkpoints, and manifest", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "fleet-reset-"));
  const experimentsDir = join(metaDir, "experiments");
  mkdirSync(experimentsDir, { recursive: true });
  writeFileSync(join(experimentsDir, "watch.log"), "big log\n".repeat(100));
  writeFileSync(join(experimentsDir, "sdk-worker-1.json"), JSON.stringify({ ticks: [{ tick: 1 }] }));
  writeFileSync(
    join(experimentsDir, "sdk-worker-1.session-2026-07-27T12-00-00-000Z.json"),
    "{}",
  );
  writeFileSync(join(experimentsDir, "watch-status.json"), "{}");
  writeFileSync(
    join(experimentsDir, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      experiments: [{ name: "sdk-worker-1", pid: 999999 }],
      watcherPid: 999998,
    }),
  );
  writeFileSync(
    join(metaDir, "plan-budget.json"),
    JSON.stringify({
      limits: {},
      events: [{ at: new Date().toISOString(), action: "ide_tick" }],
      fleetStartedAt: new Date().toISOString(),
      ideTicks: 42,
      estimatedCents: 224,
      sdkRuns: 3,
    }),
  );

  const result = wipeFleetDashboardState({ metaDir, root: "/repo" });
  assert.equal(result.budgetReset, true);
  assert.ok(result.removedFiles.includes("watch.log"));
  assert.ok(result.removedFiles.includes("sdk-worker-1.json"));
  assert.ok(!existsSync(join(experimentsDir, "watch.log")));
  assert.ok(!existsSync(join(experimentsDir, "sdk-worker-1.json")));

  const budget = JSON.parse(readFileSync(join(metaDir, "plan-budget.json"), "utf8")) as {
    ideTicks: number;
    estimatedCents: number;
    sdkRuns: number;
    fleetStartedAt?: string;
  };
  assert.equal(budget.ideTicks, 0);
  assert.equal(budget.estimatedCents, 0);
  assert.equal(budget.sdkRuns, 0);
  assert.equal(budget.fleetStartedAt, undefined);

  const manifest = JSON.parse(readFileSync(join(experimentsDir, "manifest.json"), "utf8")) as {
    experiments: unknown[];
    watcherPid: number;
  };
  assert.equal(manifest.experiments.length, 0);
  assert.equal(manifest.watcherPid, -1);
});
