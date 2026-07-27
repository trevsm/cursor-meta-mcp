import assert from "node:assert/strict";
import { test } from "node:test";

const { runFleetPreflight } = await import("../src/fleet-preflight.js");

test("runFleetPreflight fails without CURSOR_API_KEY when required", async () => {
  const result = await runFleetPreflight({
    skipSmokeTest: true,
    requireApiKey: true,
    env: { ...process.env, CURSOR_API_KEY: "" },
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("CURSOR_API_KEY")));
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
