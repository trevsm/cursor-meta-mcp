import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Env var for default honest-fleet / AGI worker target (prefer external repos). */
export const FLEET_TARGET_ENV = "CURSOR_META_FLEET_CWD";

/** Preferred verify scripts on external repos (first match wins). */
export const VERIFY_SCRIPT_PRIORITY = [
  "test:fast",
  "test:unit",
  "test",
  "lint",
  "type-check",
  "build:fast",
  "build",
] as const;

export interface VerifyCommand {
  command: string;
  args: string[];
  label: string;
}

export function resolveVerifyCommand(cwd: string): VerifyCommand {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    return { command: "npm", args: ["run", "--silent", "test:fast"], label: "npm run test:fast" };
  }
  try {
    const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> })
      .scripts;
    for (const name of VERIFY_SCRIPT_PRIORITY) {
      if (scripts?.[name]) {
        return { command: "npm", args: ["run", "--silent", name], label: `npm run ${name}` };
      }
    }
  } catch {
    /* fall through */
  }
  return { command: "npm", args: ["run", "--silent", "test:fast"], label: "npm run test:fast" };
}

export function cursorMetaMcpRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Resolve fleet worker cwd: CLI arg > env > process.cwd(). */
export function resolveFleetTargetCwd(explicit?: string): string {
  const fromEnv = process.env[FLEET_TARGET_ENV]?.trim();
  const raw = explicit?.trim() || fromEnv || process.cwd();
  return resolve(raw);
}

export function isSelfImproveTarget(cwd: string): boolean {
  return resolve(cwd) === resolve(cursorMetaMcpRoot());
}

export function fleetTargetWarning(cwd: string): string | null {
  if (!existsSync(join(cwd, ".git"))) {
    return `Fleet target ${cwd} is not a git repository.`;
  }
  if (isSelfImproveTarget(cwd)) {
    return [
      "Fleet target is cursor-meta-mcp itself.",
      "Prefer an external repo: export CURSOR_META_FLEET_CWD=/path/to/your-app",
      "Self-targeting fleets tend toward meta-churn and test-only ticks.",
    ].join(" ");
  }
  return null;
}
