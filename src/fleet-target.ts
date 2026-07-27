import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Env var for default honest-fleet / AGI worker target (prefer external repos). */
export const FLEET_TARGET_ENV = "CURSOR_META_FLEET_CWD";
/** pnpm/yarn workspace filter, e.g. `@faciliq/web`. */
export const FLEET_FILTER_ENV = "CURSOR_META_FLEET_FILTER";
/** Comma-separated script names to run each tick, e.g. `test,lint`. */
export const FLEET_VERIFY_SCRIPTS_ENV = "CURSOR_META_FLEET_VERIFY";

/** Preferred verify scripts on external repos (first match wins when env unset). */
export const VERIFY_SCRIPT_PRIORITY = [
  "test:fast",
  "test:unit",
  "test",
  "lint",
  "typecheck",
  "type-check",
  "build:fast",
  "build",
] as const;

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface VerifyCommand {
  command: string;
  args: string[];
  label: string;
}

function readPackageJson(cwd: string): { scripts?: Record<string, string>; packageManager?: string } | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
  } catch {
    return null;
  }
}

export function detectPackageManager(cwd: string): PackageManager {
  const pkg = readPackageJson(cwd);
  const fromField = pkg?.packageManager?.split("@")[0];
  if (fromField === "pnpm" || fromField === "yarn") return fromField;
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export function resolveFleetFilter(): string | undefined {
  const filter = process.env[FLEET_FILTER_ENV]?.trim();
  return filter || undefined;
}

export function resolveVerifyScriptNames(cwd: string): string[] {
  const fromEnv = process.env[FLEET_VERIFY_SCRIPTS_ENV]?.trim();
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  const scripts = readPackageJson(cwd)?.scripts ?? {};
  const picked: string[] = [];
  for (const name of VERIFY_SCRIPT_PRIORITY) {
    if (scripts[name]) {
      picked.push(name);
      break;
    }
  }
  if (picked.includes("test") && scripts.lint && !picked.includes("lint")) {
    picked.push("lint");
  }
  return picked;
}

export function buildPackageRunCommand(
  pm: PackageManager,
  script: string,
  filter?: string,
): VerifyCommand {
  if (pm === "pnpm") {
    const args = filter ? ["--filter", filter, "run", script] : ["run", script];
    const label = filter ? `pnpm --filter ${filter} run ${script}` : `pnpm run ${script}`;
    return { command: "pnpm", args, label };
  }
  if (pm === "yarn") {
    const args = filter
      ? ["workspace", filter, "run", script]
      : ["run", script];
    const label = filter ? `yarn workspace ${filter} run ${script}` : `yarn run ${script}`;
    return { command: "yarn", args, label };
  }
  const label = `npm run ${script}`;
  return { command: "npm", args: ["run", "--silent", script], label };
}

export function resolveVerifyCommands(cwd: string): VerifyCommand[] {
  const pm = detectPackageManager(cwd);
  const filter = resolveFleetFilter();
  const scripts = readPackageJson(cwd)?.scripts ?? {};
  const names = resolveVerifyScriptNames(cwd);

  const commands = names
    .filter((name) => scripts[name])
    .map((name) => buildPackageRunCommand(pm, name, filter));

  if (commands.length > 0) return commands;

  return [buildPackageRunCommand("npm", "test:fast")];
}

/** Primary verify command (first of the tick sequence). */
export function resolveVerifyCommand(cwd: string): VerifyCommand {
  return resolveVerifyCommands(cwd)[0]!;
}

export function formatVerifyCommandLabel(commands: VerifyCommand[]): string {
  return commands.map((cmd) => cmd.label).join(" && ");
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
