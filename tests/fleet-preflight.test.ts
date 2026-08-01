import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("runFleetPreflight reports the verify command the gate will run", async () => {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? "crsr_test_key";
  try {
    const result = await runFleetPreflight({ skipSmokeTest: true, requireApiKey: true });
    assert.ok(
      result.verifyCommand.length > 0,
      "operator must be able to see what the ground-truth gate runs before launching",
    );
  } finally {
    if (prev) process.env.CURSOR_API_KEY = prev;
    else delete process.env.CURSOR_API_KEY;
  }
});

test("runFleetPreflight warns when the resolved verify command is scoped to one package", async () => {
  const prevKey = process.env.CURSOR_API_KEY;
  const prevFilter = process.env.CURSOR_META_FLEET_FILTER;
  process.env.CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? "crsr_test_key";
  process.env.CURSOR_META_FLEET_FILTER = "@faciliq/web";

  const dir = mkdtempSync(join(tmpdir(), "preflight-workspace-"));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "node --test", lint: "eslint ." } }),
  );

  try {
    const result = await runFleetPreflight({ cwd: dir, skipSmokeTest: true, requireApiKey: true });
    assert.match(result.verifyCommand, /pnpm --filter @faciliq\/web/);
    assert.ok(
      result.warnings.some((w) => /pass the gate untested/.test(w)),
      "a scoped verify silently green-lights changes it never ran",
    );
  } finally {
    if (prevKey) process.env.CURSOR_API_KEY = prevKey;
    else delete process.env.CURSOR_API_KEY;
    if (prevFilter == null) delete process.env.CURSOR_META_FLEET_FILTER;
    else process.env.CURSOR_META_FLEET_FILTER = prevFilter;
  }
});

test("runFleetPreflight does not warn about scope when verify covers the whole workspace", async () => {
  const prevKey = process.env.CURSOR_API_KEY;
  const prevFilter = process.env.CURSOR_META_FLEET_FILTER;
  process.env.CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? "crsr_test_key";
  delete process.env.CURSOR_META_FLEET_FILTER;

  const dir = mkdtempSync(join(tmpdir(), "preflight-workspace-full-"));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }));

  try {
    const result = await runFleetPreflight({ cwd: dir, skipSmokeTest: true, requireApiKey: true });
    assert.ok(!result.warnings.some((w) => /pass the gate untested/.test(w)));
  } finally {
    if (prevKey) process.env.CURSOR_API_KEY = prevKey;
    else delete process.env.CURSOR_API_KEY;
    if (prevFilter != null) process.env.CURSOR_META_FLEET_FILTER = prevFilter;
  }
});
