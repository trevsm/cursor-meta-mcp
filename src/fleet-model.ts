/** Default model for every cursor-meta fleet / SDK / MCP agent spawn. */
export const FLEET_AGENT_MODEL = "composer-2.5-fast";

/** Fallback when the account/CLI rejects the default (e.g. "Cannot use this model"). */
export const FLEET_AGENT_MODEL_FALLBACK = "composer-2.5";

const MODEL_ENV = "CURSOR_META_FLEET_MODEL";

/** Runtime downgrade applied after a model-rejected error; process-local. */
let downgradedModel: string | undefined;

function configuredModel(): string {
  return process.env[MODEL_ENV]?.trim() || FLEET_AGENT_MODEL;
}

/**
 * Caller overrides are ignored — fleet policy is fixed per process so the LLM
 * critic cannot escalate to expensive models. Operators override via
 * CURSOR_META_FLEET_MODEL; a rejected model downgrades once at runtime.
 */
export function fleetAgentModel(_override?: string): string {
  return downgradedModel ?? configuredModel();
}

/** True when the fleet model must run via ~/.local/bin/agent (not @cursor/sdk). */
export function fleetModelRequiresCli(): boolean {
  return fleetAgentModel().startsWith("composer-");
}

/** True when an error message means the current model slug is not available. */
export function isModelRejectedError(message: string | undefined): boolean {
  if (!message) return false;
  return /cannot use this model|model .* not (?:found|available)|unknown model/i.test(message);
}

/**
 * Switch this process to the fallback model after a rejection. Returns the new
 * model, or null when no downgrade is possible (already on fallback).
 */
export function downgradeFleetModel(): string | null {
  const current = fleetAgentModel();
  if (current === FLEET_AGENT_MODEL_FALLBACK) return null;
  downgradedModel = FLEET_AGENT_MODEL_FALLBACK;
  return downgradedModel;
}

/** Test-only: clear the runtime downgrade. */
export function resetFleetModelForTests(): void {
  downgradedModel = undefined;
}
