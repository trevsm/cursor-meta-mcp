#!/usr/bin/env node
/**
 * Relentless loop CLI — self-critique until approved.
 *
 * Usage:
 *   node scripts/relentless-loop.mjs "Fix the failing tests" /path/to/project
 *   node scripts/relentless-loop.mjs --ide --session 5 "Continue sentiment work" /path/to/project
 */
import { CursorLocalService } from "../dist/cursor-local.js";
import { runRelentlessLoop } from "../dist/relentless-loop.js";

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    ide: false,
    sessionIndex: undefined,
    sessionId: undefined,
    maxIterations: 8,
    cwd: undefined,
    taskParts: [],
  };

  while (args.length > 0) {
    const token = args[0];
    if (token === "--ide") {
      options.ide = true;
      args.shift();
      continue;
    }
    if (token === "--session") {
      options.sessionIndex = Number(args[1]);
      args.splice(0, 2);
      continue;
    }
    if (token === "--session-id") {
      options.sessionId = args[1];
      args.splice(0, 2);
      continue;
    }
    if (token === "--max") {
      options.maxIterations = Number(args[1]);
      args.splice(0, 2);
      continue;
    }
    break;
  }

  if (args.length < 2) {
    throw new Error(
      "Usage: relentless-loop.mjs [--ide] [--session N] [--max N] <task...> <cwd>",
    );
  }

  options.cwd = args.at(-1);
  options.taskParts = args.slice(0, -1);
  return {
    ...options,
    task: options.taskParts.join(" "),
    target: options.ide || options.sessionIndex || options.sessionId ? "ide" : "sdk",
  };
}

const params = parseArgs(process.argv.slice(2));
const service = new CursorLocalService({ apiKey: process.env.CURSOR_API_KEY });

console.error(`Relentless loop starting (${params.target})…`);
const result = await runRelentlessLoop(service, {
  task: params.task,
  cwd: params.cwd,
  target: params.target,
  sessionIndex: params.sessionIndex,
  sessionId: params.sessionId,
  maxIterations: params.maxIterations,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.approved ? 0 : 1);
