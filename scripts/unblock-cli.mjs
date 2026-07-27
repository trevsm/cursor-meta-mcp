#!/usr/bin/env node
/**
 * Expand Cursor CLI allowlist for autonomous agent ticks (Shell + MCP).
 * Invoked manually or from tooling after allowlist gets narrowed to Shell(ls).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allow = ["Shell(**)", "Mcp(**)"];

const globalPath = join(homedir(), ".cursor", "cli-config.json");
const global = JSON.parse(readFileSync(globalPath, "utf8"));
global.permissions ??= {};
global.permissions.allow = [...new Set([...allow, ...(global.permissions.allow ?? [])])].filter(
  (p) => p !== "Shell(ls)",
);
global.approvalMode = "allowlist";
writeFileSync(globalPath, `${JSON.stringify(global, null, 2)}\n`);

const projDir = join(root, ".cursor");
mkdirSync(projDir, { recursive: true });
const override = join(root, "scripts/cli-project-override.json");
if (existsSync(override)) {
  writeFileSync(join(projDir, "cli.json"), readFileSync(override));
}

const probe = join(root, "src", ".probe-write.ts");
if (existsSync(probe)) unlinkSync(probe);

console.log("CLI permissions expanded to Shell(**) and Mcp(**). Restart agent sessions to pick up.");
