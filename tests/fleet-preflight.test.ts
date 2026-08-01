import assert from "node:assert/strict";
import { test } from "node:test";

const { runFleetPreflight } = await import("../src/fleet-preflight.js");

test("runFleetPreflight fails without worker auth when required", async () => {
  // Pin an SDK-routed model so CLI login on the host cannot satisfy the gate.
  const prevModel = process.env.CURSOR_META_FLEET_MODEL;
  process.env.CURSOR_META_FLEET_MODEL = "gpt-5.5";
  try {
    const result = await runFleetPreflight({
      skipSmokeTest: true,
      requireApiKey: true,
      env: { ...process.env, CURSOR_API_KEY: "" },
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("CURSOR_API_KEY")));
  } finally {
    if (prevModel == null) delete process.env.CURSOR_META_FLEET_MODEL;
    else process.env.CURSOR_META_FLEET_MODEL = prevModel;
  }
});

test("runFleetPreflight passes with api key on node 22+", async () => {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? "crsr_test_key";
  try {
    const major = Number(process.versions.node.split(".")[0]);
    const result = await runFleetPreflight({ skipSmokeTest: true, requireApiKey: true });
    if (major >= 22) {
      assert.equal(result.ok, true, result.failures.join("; "));
    }
    if (major !== 22) {
      assert.ok(result.warnings.some((w) => /not 22\.x/i.test(w)));
    }
  } finally {
    if (prev) process.env.CURSOR_API_KEY = prev;
    else delete process.env.CURSOR_API_KEY;
  }
});
