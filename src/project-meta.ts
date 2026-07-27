import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { join } from "node:path";

import { metaHome } from "./meta-home.js";

/** Normalize and absolutize a project root path. */
export function resolveProjectRoot(cwd: string): string {
  return resolve(cwd.trim());
}

/** Stable slug for per-project fleet state under ~/.cursor-meta/projects/. */
export function projectSlug(cwd: string): string {
  const root = resolveProjectRoot(cwd);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 10);
  const name =
    basename(root)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  return `${name}-${hash}`;
}

/** Per-project meta root (budget, world episodes scoped to this mission). */
export function projectMetaDir(cwd: string): string {
  return join(metaHome(), "projects", projectSlug(cwd));
}

/** Fleet manifests, checkpoints, and worker logs for one project. */
export function experimentsDirForProject(cwd: string): string {
  return join(projectMetaDir(cwd), "experiments");
}

export function workspaceNameForProject(cwd: string): string {
  return basename(resolveProjectRoot(cwd)) || "project";
}
