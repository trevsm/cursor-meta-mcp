import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  cursorMetaMcpRoot,
  fleetTargetWarning,
  isSelfImproveTarget,
  resolveFleetTargetCwd,
  resolveVerifyCommand,
} from "../src/fleet-target.js";

test("resolveFleetTargetCwd prefers explicit arg over env", () => {
  const prev = process.env.CURSOR_META_FLEET_CWD;
  process.env.CURSOR_META_FLEET_CWD = "/tmp/from-env";
  try {
    assert.equal(resolveFleetTargetCwd("/tmp/explicit"), "/tmp/explicit");
  } finally {
    if (prev === undefined) delete process.env.CURSOR_META_FLEET_CWD;
    else process.env.CURSOR_META_FLEET_CWD = prev;
  }
});

test("isSelfImproveTarget detects cursor-meta-mcp root", () => {
  assert.equal(isSelfImproveTarget(cursorMetaMcpRoot()), true);
  assert.equal(isSelfImproveTarget("/tmp/other-project"), false);
});

test("resolveVerifyCommand picks best script from package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-verify-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { lint: "eslint .", build: "next build" } }),
  );
  assert.deepEqual(resolveVerifyCommand(dir), {
    command: "npm",
    args: ["run", "--silent", "lint"],
    label: "npm run lint",
  });
});

test("resolveVerifyCommand prefers test:fast when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-verify-fast-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { "test:fast": "vitest run", lint: "eslint ." } }),
  );
  assert.equal(resolveVerifyCommand(dir).label, "npm run test:fast");
});

test("fleetTargetWarning warns on self-target", () => {
  const warning = fleetTargetWarning(cursorMetaMcpRoot());
  assert.ok(warning);
  assert.match(warning, /cursor-meta-mcp/i);
  assert.match(warning, /CURSOR_META_FLEET_CWD/i);
});
