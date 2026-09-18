#!/usr/bin/env node
import { clusterAtlasSubthemes } from "../dist/atlas-index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
const useLlm = process.argv.includes("--llm");

console.error(`Clustering atlas subthemes (llm=${useLlm})…`);

const index = await clusterAtlasSubthemes({
  cwd,
  useLlm,
  onProgress: (msg) => console.error(msg),
});

if (!index) {
  console.error("No atlas index found");
  process.exit(1);
}

const groups = new Map();
for (const seg of index.segments) {
  const key = `${seg.themeId}::${seg.groupLabel ?? "?"}`;
  groups.set(key, (groups.get(key) ?? 0) + 1);
}

console.error(`Done: ${groups.size} subtopic groups across ${index.themes.length} themes`);
console.log(
  JSON.stringify(
    {
      generatedAt: index.generatedAt,
      sessions: index.sessions.length,
      segments: index.segments.length,
      subtopicGroups: groups.size,
    },
    null,
    2,
  ),
);
