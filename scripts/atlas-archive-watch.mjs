#!/usr/bin/env node
import {
  startBubbleArchiveWatcher,
  stopBubbleArchiveWatcher,
} from "../dist/atlas-bubble-archive.js";

const cfg = {
  intervalMs: Number(process.env.ATLAS_ARCHIVE_INTERVAL_MS ?? 15_000),
  hotWithinMs: Number(process.env.ATLAS_ARCHIVE_HOT_MS ?? 10 * 60 * 1000),
};

console.error("Atlas bubble archive watcher running (always-on mode)");
console.error(`Archive DB: ~/.cursor-meta/atlas/bubble-archive.db`);
console.error(`Interval: ${cfg.intervalMs}ms · hot window: ${cfg.hotWithinMs / 1000}s`);

startBubbleArchiveWatcher(cfg);

function shutdown() {
  stopBubbleArchiveWatcher();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
