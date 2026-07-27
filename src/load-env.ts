import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Parse KEY=VALUE lines from a dotenv file (no export prefix, # comments skipped). */
export function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function cursorEnvFilePath(): string {
  return join(homedir(), ".cursor", ".env");
}

/** Load ~/.cursor/.env into a copy of process.env for detached worker spawns. */
export function envForWorkers(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) merged[key] = value;
  }
  const path = cursorEnvFilePath();
  if (existsSync(path)) {
    Object.assign(merged, parseDotenv(readFileSync(path, "utf8")));
  }
  if (extra) Object.assign(merged, extra);
  return merged;
}

export function hasCursorApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CURSOR_API_KEY?.trim());
}

/** Prefer Node 22 for detached workers — better-sqlite3 pulse/history breaks on Node 24+. */
export function resolveWorkerNodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CURSOR_META_NODE?.trim();
  if (override) return override;
  const major = Number(process.version.slice(1).split(".")[0]);
  if (major === 22) return process.execPath;
  const nvm22 = join(homedir(), ".nvm/versions/node/v22.22.3/bin/node");
  if (existsSync(nvm22)) return nvm22;
  return process.execPath;
}
