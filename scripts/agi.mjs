#!/usr/bin/env node
/**
 * Start AGI mode on any project from the CLI (MCP-free fallback).
 *
 *   npm run agi -- /path/to/project "Build the checkout flow"
 *   npm run agi -- --cwd /path/to/project --task "Fix flaky tests"
 */
import { launchAgiMission } from "../src/agi-mission.js";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cwd = argValue("--cwd") ?? process.argv[2];
const task = argValue("--task") ?? process.argv[3];

if (!cwd?.trim() || !task?.trim()) {
  console.error("Usage: npm run agi -- <cwd> <task>");
  console.error("   or: npm run agi -- --cwd /path --task \"Your mission\"");
  process.exit(1);
}

const port = Number.parseInt(argValue("--port") ?? "3847", 10);

try {
  const result = await launchAgiMission({
    cwd,
    task,
    dashboardPort: port,
  });
  for (const warning of result.preflightWarnings) {
    console.error(`[agi] warn: ${warning}`);
  }
  console.log(JSON.stringify(result, null, 2));
  console.error(`\nDashboard: ${result.dashboardUrl}`);
  console.error(`Start UI:  ${result.dashboardCommand}`);
} catch (error) {
  console.error(`[agi] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
