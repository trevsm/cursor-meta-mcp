#!/usr/bin/env node
import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const labels = [
  "com.cursor-meta.atlas-app",
  "com.cursor-meta.atlas-server",
  "com.cursor-meta.atlas-archive",
  "com.cursor-meta.atlas-menubar",
];
const gui = `gui/${execSync("id -u", { encoding: "utf8" }).trim()}`;

for (const label of labels) {
  try {
    execSync(`launchctl bootout ${gui}/${label}`, { stdio: "pipe" });
  } catch {
    // ignore
  }
  try {
    unlinkSync(join(homedir(), "Library/LaunchAgents", `${label}.plist`));
  } catch {
    // ignore
  }
}

console.error("Removed Conversation Atlas LaunchAgents.");
