#!/usr/bin/env node
/**
 * Re-exec argv under the preferred worker Node (22.x via nvm when host is 24+).
 * Usage: node --import tsx scripts/run-with-worker-node.mjs --test ... <test-globs>
 */
import { spawn } from "node:child_process";
import { resolveWorkerNodeBin } from "../src/load-env.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: run-with-worker-node.mjs <node-args...>");
  process.exit(2);
}

const nodeBin = resolveWorkerNodeBin();
const child = spawn(nodeBin, args, {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
