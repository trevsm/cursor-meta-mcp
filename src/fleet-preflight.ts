import { execFileSync } from "node:child_process";

import { loadBudgetState, getBudgetSnapshot } from "./plan-budget.js";
import { hasCursorApiKey, resolveWorkerNodeBin, envForWorkers } from "./load-env.js";
import { probeWorkerAuth, workerAuthHint } from "./worker-auth.js";

export interface FleetPreflightResult {
  ok: boolean;
  failures: string[];
  warnings: string[];
  auth: Awaited<ReturnType<typeof probeWorkerAuth>>;
}

export async function runFleetPreflight(options?: {
  cwd?: string;
  requireApiKey?: boolean;
  skipSmokeTest?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<FleetPreflightResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const requireApiKey = options?.requireApiKey ?? true;
  const cwd = options?.cwd?.trim() || process.cwd();
  const env = options?.env ?? envForWorkers();

  const auth = await probeWorkerAuth(env);
  if (requireApiKey && !auth.apiKey) {
    failures.push(`CURSOR_API_KEY missing — ${workerAuthHint(auth)}`);
  } else if (!auth.sdk) {
    warnings.push(workerAuthHint(auth));
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    failures.push(`Node ${process.version} — fleet requires Node >= 22`);
  } else if (major !== 22) {
    warnings.push(
      `Node ${process.version} — MCP host is not 22.x; detached workers will use nvm Node 22 when available`,
    );
  }

  try {
    resolveWorkerNodeBin();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const budget = getBudgetSnapshot(loadBudgetState());
  if (budget.blockedActions.includes("spawn_fleet_worker")) {
    failures.push(...budget.warnings);
  } else {
    warnings.push(...budget.warnings);
  }

  if (!options?.skipSmokeTest && process.env.CURSOR_META_PREFLIGHT_SMOKE === "1") {
    try {
      execFileSync("npm", ["run", "test:fast", "--", "tests/load-env.test.ts"], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, CURSOR_META_HOME: process.env.CURSOR_META_HOME ?? "" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`npm run test:fast smoke failed — ${message.slice(0, 200)}`);
    }
  }

  if (!hasCursorApiKey(env) && auth.cli) {
    warnings.push("CLI login detected but detached SDK workers need CURSOR_API_KEY in ~/.cursor/.env");
  }

  return { ok: failures.length === 0, failures, warnings, auth };
}
