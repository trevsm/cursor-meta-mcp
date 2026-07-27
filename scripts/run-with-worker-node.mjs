#!/usr/bin/env node
/**
 * Re-exec argv under the preferred worker Node (22.x via nvm when host is 24+).
 * Usage: node --import tsx scripts/run-with-worker-node.mjs --test ... <test-globs>
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkerNodeBin } from "../src/load-env.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function expandTestFileArgs(argv) {
  const hasGlob = argv.some((arg) => arg.includes("tests/") && arg.includes("*"));
  const hasTestFile = argv.some((arg) => {
    if (!arg.endsWith(".test.ts")) return false;
    return existsSync(arg) || existsSync(join(ROOT, arg));
  });
  if (!hasGlob && hasTestFile) return argv;

  const withoutGlobs = argv.filter((arg) => !(arg.includes("tests/") && arg.includes("*")));
  const files = readdirSync(join(ROOT, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => join(ROOT, "tests", name))
    .sort();
  return [...withoutGlobs, ...files];
}

const args = expandTestFileArgs(process.argv.slice(2));
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
