import { isAgentCliLoggedIn } from "./agent-cli.js";
import { fleetModelRequiresCli } from "./fleet-model.js";
import { hasCursorApiKey, envForWorkers } from "./load-env.js";

export interface WorkerAuthStatus {
  sdk: boolean;
  cli: boolean;
  apiKey: boolean;
}

export async function probeWorkerAuth(env: NodeJS.ProcessEnv = envForWorkers()): Promise<WorkerAuthStatus> {
  const apiKey = hasCursorApiKey(env);
  const cli = apiKey ? true : await isAgentCliLoggedIn();
  return { apiKey, cli, sdk: apiKey || cli };
}

/**
 * True when headless SDK-mode workers can launch with this auth. API key always
 * works; CLI login alone is enough when the fleet model runs through the agent
 * CLI anyway (cursor-local routes composer-* runs to ~/.local/bin/agent).
 */
export function sdkWorkerLaunchable(auth: WorkerAuthStatus): boolean {
  return auth.apiKey || (auth.cli && fleetModelRequiresCli());
}

/** Prefer SDK when auth supports headless workers; otherwise IDE long-sessions. */
export async function resolveHonestWorkerMode(
  requested: "ide" | "sdk" | "hybrid" | undefined,
  env: NodeJS.ProcessEnv = envForWorkers(),
): Promise<"ide" | "sdk" | "hybrid"> {
  const auth = await probeWorkerAuth(env);
  const sdkOk = sdkWorkerLaunchable(auth);
  if (requested === "ide") return "ide";
  if (requested === "hybrid") return sdkOk ? "hybrid" : "ide";
  if (requested === "sdk") return sdkOk ? "sdk" : "ide";
  return sdkOk ? "sdk" : "ide";
}

export function workerAuthHint(status: WorkerAuthStatus): string {
  if (status.apiKey) {
    return "Using CURSOR_API_KEY for SDK worker.";
  }
  if (status.cli && fleetModelRequiresCli()) {
    return "Using Agent CLI login for headless workers (fleet model is CLI-routed).";
  }
  if (status.cli) {
    return "Agent CLI login works for interactive runs; detached SDK-model workers require CURSOR_API_KEY in ~/.cursor/.env.";
  }
  return "No SDK auth — falling back to IDE long-session worker. Set CURSOR_API_KEY in ~/.cursor/.env or run ~/.local/bin/agent login.";
}
