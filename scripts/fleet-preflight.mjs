#!/usr/bin/env node
import { runFleetPreflight } from "../src/fleet-preflight.js";

const smoke = process.argv.includes("--smoke");
const result = await runFleetPreflight({
  cwd: process.argv.find((arg) => !arg.startsWith("-")) ?? process.cwd(),
  skipSmokeTest: !smoke,
});

for (const warning of result.warnings) {
  console.error(`[fleet:preflight] warn: ${warning}`);
}

if (!result.ok) {
  for (const failure of result.failures) {
    console.error(`[fleet:preflight] fail: ${failure}`);
  }
  process.exit(1);
}

console.log("[fleet:preflight] ok");
console.error(`[fleet:preflight] ${result.auth.apiKey ? "CURSOR_API_KEY set" : "auth via CLI only"}`);
