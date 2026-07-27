#!/usr/bin/env node
/**
 * Consciousness Pulse CLI — delegates to the MCP module.
 */
import { runConsciousnessPulse } from "../src/consciousness-pulse.js";

const limitArg = process.argv.indexOf("--limit");
const workspaceArg = process.argv.indexOf("--workspace");

const params = {
  limit: limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined,
  workspace: workspaceArg >= 0 ? process.argv[workspaceArg + 1] : undefined,
};

console.log(JSON.stringify(runConsciousnessPulse(params), null, 2));
