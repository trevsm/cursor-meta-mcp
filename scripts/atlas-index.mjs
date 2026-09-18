#!/usr/bin/env node
import { buildAtlasIndex } from "../dist/atlas-index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
const useLlm = process.argv.includes("--llm");
const skipExisting = process.argv.includes("--skip-existing");
const skipEmpty = process.argv.includes("--skip-empty");
const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const targetArg = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
const limit = Number(limitArg ?? targetArg ?? 10);
const targetTotal =
  targetArg ? Number(targetArg) : limitArg && skipExisting && !skipEmpty ? Number(limitArg) : undefined;

console.error(
  `Building atlas index (target=${skipEmpty && skipExisting ? `+${limit} valid` : targetTotal ?? limit}, llm=${useLlm}, skipExisting=${skipExisting}, skipEmpty=${skipEmpty})…`,
);

const index = await buildAtlasIndex({
  limit,
  targetTotal,
  skipExisting,
  skipEmpty,
  useLlm,
  cwd,
  onProgress: (msg) => console.error(msg),
});

console.error(`Done: ${index.sessions.length} sessions, ${index.segments.length} segments, ${index.themes.length} themes (${index.source})`);
console.log(JSON.stringify({ generatedAt: index.generatedAt, source: index.source, counts: {
  sessions: index.sessions.length,
  segments: index.segments.length,
  themes: index.themes.length,
}}, null, 2));
