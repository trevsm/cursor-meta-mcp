import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root directory for persistent cursor-meta state (SDK run event logs).
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

/** Default location for SDK run event logs. */
export function runsDir(): string {
  return metaPath("runs");
}
