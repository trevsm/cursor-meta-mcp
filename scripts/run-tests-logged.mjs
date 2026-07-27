#!/usr/bin/env node
/**
 * Fire-and-forget test runner for long-session workers when interactive Shell is blocked.
 * Writes results to ~/.cursor-meta/experiments/npm-test-latest.log
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkerNodeBin } from "../src/load-env.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(homedir(), ".cursor-meta", "experiments");
mkdirSync(OUT_DIR, { recursive: true });
const logPath = join(OUT_DIR, "npm-test-latest.log");
const nodeBin = resolveWorkerNodeBin();
const nodeDir = dirname(nodeBin);

const out = createWriteStream(logPath, { flags: "w" });
out.write(`[${new Date().toISOString()}] npm test starting via ${nodeBin}\n`);

const child = spawn("npm", ["test"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.pipe(out);
child.stderr.pipe(out);

child.on("close", (code) => {
  writeFileSync(
    join(OUT_DIR, "npm-test-exit.txt"),
    `exit=${code}\nat=${new Date().toISOString()}\n`,
  );
  out.write(`\n[${new Date().toISOString()}] EXIT:${code}\n`);
  out.end();
  process.exit(code ?? 1);
});
