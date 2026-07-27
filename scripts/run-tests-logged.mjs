#!/usr/bin/env node
/**
 * Fire-and-forget test runner for long-session workers when interactive Shell is blocked.
 * Writes results to ~/.cursor-meta/experiments/npm-test-latest.log
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = "/Users/trevorsmith/Projects/cursor-meta-mcp";
const OUT_DIR = join(homedir(), ".cursor-meta", "experiments");
mkdirSync(OUT_DIR, { recursive: true });
const logPath = join(OUT_DIR, "npm-test-latest.log");

const out = createWriteStream(logPath, { flags: "w" });
out.write(`[${new Date().toISOString()}] npm test starting\n`);

const child = spawn("npm", ["test"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.3/bin:${process.env.PATH}`,
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
