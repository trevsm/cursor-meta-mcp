#!/usr/bin/env node
/**
 * Orchestrate Pulse CLI — scan and optionally execute recommended actions.
 *
 * Usage:
 *   node scripts/orchestrate-pulse.mjs --dry-run
 *   node scripts/orchestrate-pulse.mjs --workspace cursor-meta-mcp --max 2
 *   node scripts/orchestrate-pulse.mjs --allow-intercept --max 1
 */
import { CursorLocalService } from "../src/cursor-local.js";
import { orchestratePulse } from "../src/orchestrate-pulse.js";

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const params = {
  limit: argValue("--limit") ? Number(argValue("--limit")) : undefined,
  workspace: argValue("--workspace"),
  dryRun: flag("--dry-run"),
  allowWatch: flag("--no-watch") ? false : undefined,
  allowContinue: flag("--no-continue") ? false : undefined,
  allowIntercept: flag("--allow-intercept") || undefined,
  allowSpawn: flag("--allow-spawn") || undefined,
  maxActions: argValue("--max") ? Number(argValue("--max")) : undefined,
};

const service = new CursorLocalService({ apiKey: process.env.CURSOR_API_KEY });
const result = await orchestratePulse(params, service);

console.log(JSON.stringify(result, null, 2));
process.exit(result.executed.some((action) => action.error) ? 1 : 0);
