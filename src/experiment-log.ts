import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_KEEP_LINES = 500;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function maxExperimentLogBytes(): number {
  return parseIntEnv("CURSOR_META_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
}

export function maxExperimentLogLines(): number {
  return parseIntEnv("CURSOR_META_LOG_KEEP_LINES", DEFAULT_KEEP_LINES);
}

/** Append one line and trim oldest content when the file exceeds size budget. */
export function appendExperimentLog(
  filePath: string,
  line: string,
  options?: { maxBytes?: number; keepLines?: number },
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${line}\n`, { flag: "a" });

  const maxBytes = options?.maxBytes ?? maxExperimentLogBytes();
  const keepLines = options?.keepLines ?? maxExperimentLogLines();
  if (!existsSync(filePath)) return;

  try {
    const stat = statSync(filePath);
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (stat.size <= maxBytes && lines.length <= keepLines) return;
    const kept = lines.slice(-keepLines).join("\n");
    writeFileSync(filePath, kept ? `${kept}\n` : "");
  } catch {
    /* best-effort rotation */
  }
}

export function formatWatchLogLine(snapshot: {
  at?: string;
  budget?: { warnings?: string[]; blockedActions?: string[]; status?: string };
  experiments?: Array<{
    name?: string;
    alive?: boolean;
    relaunched?: boolean;
    relaunchBlocked?: boolean;
    relaunchBlockedReason?: string;
    checkpoint?: { ticks?: number; productiveRatio?: number };
  }>;
}): string {
  const experiments = snapshot.experiments ?? [];
  const alive = experiments.filter((row) => row.alive).length;
  const relaunched = experiments.filter((row) => row.relaunched).map((row) => row.name ?? "?");
  const blocked = experiments
    .filter((row) => row.relaunchBlocked)
    .map((row) => `${row.name}:${(row.relaunchBlockedReason ?? "blocked").slice(0, 48)}`);
  const ticks = experiments
    .filter((row) => row.name?.startsWith("sdk-worker"))
    .map((row) => `${row.name}=${row.checkpoint?.ticks ?? 0}t`)
    .join(",");
  const budget =
    snapshot.budget?.blockedActions?.length
      ? "blocked"
      : snapshot.budget?.warnings?.[0]?.slice(0, 72) ?? snapshot.budget?.status ?? "ok";
  return `[${snapshot.at ?? new Date().toISOString()}] alive=${alive}/${experiments.length} budget=${budget}${ticks ? ` workers=${ticks}` : ""}${relaunched.length ? ` relaunched=${relaunched.join(",")}` : ""}${blocked.length ? ` blocked=${blocked.join(";")}` : ""}`;
}

export function formatStrategyLogLine(snapshot: {
  at?: string;
  onTrack?: boolean;
  score?: number;
  issues?: string[];
  recommendation?: string;
  actions?: unknown[];
}): string {
  const issues = (snapshot.issues ?? []).join(",") || "none";
  const rec = (snapshot.recommendation ?? "").replace(/\s+/g, " ").trim().slice(0, 96);
  return `[${snapshot.at ?? new Date().toISOString()}] onTrack=${snapshot.onTrack === true} score=${snapshot.score ?? "?"} issues=${issues} actions=${snapshot.actions?.length ?? 0}${rec ? ` rec=${rec}` : ""}`;
}
