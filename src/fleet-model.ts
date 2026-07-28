/** Mandatory model for every cursor-meta fleet / SDK / MCP agent spawn. */
export const FLEET_AGENT_MODEL = "composer-2.5-fast";

/** Caller overrides are ignored — fleet policy is fixed. */
export function fleetAgentModel(_override?: string): string {
  return FLEET_AGENT_MODEL;
}

/** True when the fleet model must run via ~/.local/bin/agent (not @cursor/sdk). */
export function fleetModelRequiresCli(): boolean {
  return FLEET_AGENT_MODEL === "composer-2.5-fast";
}
