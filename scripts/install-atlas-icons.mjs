#!/usr/bin/env node
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_SRC = join(ROOT, "assets", "atlas-icon");
const iconsDir = join(homedir(), ".cursor-meta", "icons");
const renderer = join(ROOT, "scripts", "render-atlas-icons.swift");

execSync(`swift "${renderer}" "${ICON_SRC}" "${iconsDir}"`, { stdio: "inherit" });
console.error("Restart Conversation Atlas app to pick up menu bar / dock icons.");
