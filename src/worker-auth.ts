import { isAgentCliLoggedIn } from "./agent-cli.js";
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

/** Prefer SDK when CURSOR_API_KEY exists; CLI login alone cannot run detached fleet workers. */
export async function resolveHonestWorkerMode(
  requested: "ide" | "sdk" | "hybrid" | undefined,
  env: NodeJS.ProcessEnv = envForWorkers(),
): Promise<"ide" | "sdk" | "hybrid"> {
  const auth = await probeWorkerAuth(env);
  if (requested === "ide") return "ide";
  if (requested === "hybrid") return auth.apiKey ? "hybrid" : "ide";
  if (requested === "sdk") return auth.apiKey ? "sdk" : "ide";
  return auth.apiKey ? "sdk" : "ide";
}

export function workerAuthHint(status: WorkerAuthStatus): string {
  if (status.sdk) {
    return status.apiKey
      ? "Using CURSOR_API_KEY for SDK worker."
      : "Using Agent CLI login for SDK worker (one-shot runs).";
  }
  return "No SDK auth — falling back to IDE long-session worker. Set CURSOR_API_KEY in ~/.cursor/.env or run ~/.local/bin/agent login.";
}
