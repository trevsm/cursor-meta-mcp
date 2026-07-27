#!/usr/bin/env node
/**
 * One-shot test runner for long-session worker ticks.
 * Writes a machine-readable summary to /tmp/cursor-meta-npm-test-result.txt
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const result = spawnSync("npm", ["test"], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
  shell: true,
});

const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const tests = combined.match(/^# tests (\d+)/m)?.[1] ?? "?";
const pass = combined.match(/^# pass (\d+)/m)?.[1] ?? "?";
const fail = combined.match(/^# fail (\d+)/m)?.[1] ?? "?";
const coverage = combined.match(/all files[^\n]*?([\d.]+)\s*%/i)?.[1] ?? "?";

const summary = [
  `exit=${result.status ?? 1}`,
  `tests=${tests}`,
  `pass=${pass}`,
  `fail=${fail}`,
  `coverage_lines=${coverage}`,
  "",
  combined.slice(-4000),
].join("\n");

writeFileSync("/tmp/cursor-meta-npm-test-result.txt", summary);
process.exit(result.status ?? 1);
