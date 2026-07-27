import assert from "node:assert/strict";
import { test } from "node:test";

import {
  experimentsDirForProject,
  projectMetaDir,
  projectSlug,
  resolveProjectRoot,
  workspaceNameForProject,
} from "../src/project-meta.js";

test("projectSlug is stable for the same cwd", () => {
  const cwd = "/Users/me/Projects/my-app";
  assert.equal(projectSlug(cwd), projectSlug(cwd));
  assert.match(projectSlug(cwd), /^my-app-[a-f0-9]{10}$/);
});

test("project meta paths nest under meta home", () => {
  process.env.CURSOR_META_HOME = "/tmp/cursor-meta-test-project";
  const cwd = "/Users/me/Projects/acme-api";
  assert.equal(workspaceNameForProject(cwd), "acme-api");
  assert.ok(resolveProjectRoot(cwd).endsWith("acme-api"));
  assert.match(projectMetaDir(cwd), /\/projects\/acme-api-[a-f0-9]{10}$/);
  assert.match(experimentsDirForProject(cwd), /\/experiments$/);
});
