import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root directory for all persistent cursor-meta state (world model, budget ledger,
 * fleet manifests, run events).
 *
 * Resolved per call rather than cached so `CURSOR_META_HOME` can be set at runtime.
 * Tests set it to a temp directory; without that, unit tests write fixture data into
 * the real research ledger and corrupt every downstream signal that reads it.
 */
export function metaHome(): string {
  const override = process.env.CURSOR_META_HOME?.trim();
  return override || join(homedir(), ".cursor-meta");
}

export function metaPath(...parts: string[]): string {
  return join(metaHome(), ...parts);
}

/** Default location for fleet manifests, checkpoints, and worker logs. */
export function experimentsDir(): string {
  return metaPath("experiments");
}
