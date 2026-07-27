import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  decodeWorkspaceId,
  listDashboardWorkspaces,
  resolveDashboardContext,
} from "../src/dashboard-workspaces.js";

test("listDashboardWorkspaces finds global and per-project manifests", () => {
  const home = mkdtempSync(join(tmpdir(), "dash-ws-"));
  const globalExp = join(home, "experiments");
  mkdirSync(globalExp, { recursive: true });
  writeFileSync(
    join(globalExp, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      root: "/Users/me/Desktop/faciliq-platform-core",
      goal: "Ship workflow fixes",
      experiments: [{ name: "sdk-worker-1", pid: 999999999 }],
    }),
  );

  const projectMeta = join(home, "projects", "cursor-meta-mcp-deadbeef01");
  const projectExp = join(projectMeta, "experiments");
  mkdirSync(projectExp, { recursive: true });
  writeFileSync(
    join(projectExp, "manifest.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      root: "/Users/me/Projects/cursor-meta-mcp",
      experiments: [],
    }),
  );

  const workspaces = listDashboardWorkspaces(home);
  assert.equal(workspaces.length, 2);
  const labels = workspaces.map((row) => row.label).sort();
  assert.deepEqual(labels, ["cursor-meta-mcp", "faciliq-platform-core"]);
});

test("resolveDashboardContext decodes workspaceId to meta dir", () => {
  const metaDir = mkdtempSync(join(tmpdir(), "dash-ws-ctx-"));
  const id = Buffer.from(metaDir, "utf8").toString("base64url");
  assert.equal(decodeWorkspaceId(id), metaDir);

  const ctx = resolveDashboardContext({
    workspaceId: id,
    defaultMetaDir: "/tmp/default-meta",
    defaultCwd: "/tmp/default-cwd",
    defaultWorkspace: "default",
  });
  assert.equal(ctx.metaDir, metaDir);
  assert.equal(ctx.workspaceId, id);
});
