import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildPackageRunCommand,
  cursorMetaMcpRoot,
  detectPackageManager,
  fleetTargetWarning,
  formatVerifyCommandLabel,
  isSelfImproveTarget,
  resolveFleetTargetCwd,
  resolveVerifyCommand,
  resolveVerifyCommands,
  resolveVerifyScriptNames,
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

test("detectPackageManager reads packageManager field and lockfiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pm-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  assert.equal(detectPackageManager(dir), "pnpm");
});

test("buildPackageRunCommand supports pnpm filter", () => {
  assert.deepEqual(buildPackageRunCommand("pnpm", "test", "@faciliq/web"), {
    command: "pnpm",
    args: ["--filter", "@faciliq/web", "run", "test"],
    label: "pnpm --filter @faciliq/web run test",
  });
});

test("resolveVerifyCommands uses pnpm filter and test+lint default", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pnpm-verify-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { test: "turbo test", lint: "turbo lint" } }),
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  const prevFilter = process.env.CURSOR_META_FLEET_FILTER;
  const prevVerify = process.env.CURSOR_META_FLEET_VERIFY;
  delete process.env.CURSOR_META_FLEET_VERIFY;
  process.env.CURSOR_META_FLEET_FILTER = "@faciliq/web";
  try {
    const commands = resolveVerifyCommands(dir);
    assert.equal(commands.length, 2);
    assert.equal(commands[0]?.label, "pnpm --filter @faciliq/web run test");
    assert.equal(commands[1]?.label, "pnpm --filter @faciliq/web run lint");
    assert.equal(
      formatVerifyCommandLabel(commands),
      "pnpm --filter @faciliq/web run test && pnpm --filter @faciliq/web run lint",
    );
  } finally {
    if (prevFilter === undefined) delete process.env.CURSOR_META_FLEET_FILTER;
    else process.env.CURSOR_META_FLEET_FILTER = prevFilter;
    if (prevVerify === undefined) delete process.env.CURSOR_META_FLEET_VERIFY;
    else process.env.CURSOR_META_FLEET_VERIFY = prevVerify;
  }
});

test("resolveVerifyScriptNames honors CURSOR_META_FLEET_VERIFY", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-verify-env-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "t", lint: "l", build: "b" } }));
  const prev = process.env.CURSOR_META_FLEET_VERIFY;
  process.env.CURSOR_META_FLEET_VERIFY = "lint,build";
  try {
    assert.deepEqual(resolveVerifyScriptNames(dir), ["lint", "build"]);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_META_FLEET_VERIFY;
    else process.env.CURSOR_META_FLEET_VERIFY = prev;
  }
});

test("resolveVerifyCommand picks best npm script", () => {
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
