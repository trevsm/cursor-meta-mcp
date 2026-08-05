import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

import { getChatByIndex, getSessionIndexForId } from "./history-store.js";

export interface ThinkingBlock {
  bubbleId: string;
  text: string;
  charCount: number;
  durationMs?: number;
  requestId?: string;
  toolName?: string;
  modelHint?: string;
}

export interface ThinkingStats {
  bubbleCount: number;
  thinkingBlockCount: number;
  totalThinkingChars: number;
  totalThinkingDurationMs: number;
  avgThinkingChars: number;
  avgDurationMs: number;
  toolCallCount: number;
  topTools: Array<{ name: string; count: number }>;
  longestBlocks: Array<{ charCount: number; durationMs?: number; preview: string }>;
}

export interface EfficiencyInsight {
  id: string;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string;
}

function globalDbFile(): string {
  const override = process.env.CURSOR_META_STATE_DB;
  if (override) return override;
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function openGlobalDb(): Database.Database {
  const db = new Database(globalDbFile(), { readonly: true, fileMustExist: true });
  db.pragma("mmap_size = 268435456");
  db.pragma("busy_timeout = 2000");
  return db;
}

function bubbleKeyRange(sessionId: string): { start: string; end: string } {
  const start = `bubbleId:${sessionId}:`;
  const end = `${start.slice(0, -1)};`;
  return { start, end };
}

interface BubbleJson {
  bubbleId?: string;
  type?: number;
  text?: string;
  requestId?: string;
  thinkingDurationMs?: number;
  thinking?: { text?: string; signature?: string };
  allThinkingBlocks?: Array<{ text?: string }>;
  toolFormerData?: { name?: string; status?: string };
  modelInfo?: { modelName?: string };
}

function extractThinkingFromBubble(raw: string): {
  thinking?: ThinkingBlock;
  toolName?: string;
} {
  const bubble = JSON.parse(raw) as BubbleJson;
  const toolName = bubble.toolFormerData?.name;
  const text = (bubble.thinking?.text ?? "").trim();
  if (!text && !bubble.allThinkingBlocks?.length) {
    return { toolName };
  }

  const combined =
    text ||
    (bubble.allThinkingBlocks ?? [])
      .map((block) => block.text ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

  if (!combined) return { toolName };

  return {
    toolName,
    thinking: {
      bubbleId: bubble.bubbleId ?? "",
      text: combined,
      charCount: combined.length,
      durationMs: bubble.thinkingDurationMs,
      requestId: bubble.requestId || undefined,
      toolName,
      modelHint: bubble.modelInfo?.modelName,
    },
  };
}

export function loadChatThinking(args: {
  sessionId: string;
  /** Max thinking blocks to return (most recent). Stats still scan all unless capped. */
  limit?: number;
  /** Cap bubbles scanned for huge chats (default 50k). */
  maxBubblesScan?: number;
  includeTexts?: boolean;
}): {
  sessionId: string;
  stats: ThinkingStats;
  blocks: ThinkingBlock[];
  analysisTexts: string[];
  scannedBubbles: number;
  truncatedScan: boolean;
} {
  const db = openGlobalDb();
  try {
    const { start, end } = bubbleKeyRange(args.sessionId);
    const maxScan = args.maxBubblesScan ?? 50_000;
    const rows = db
      .prepare(
        `SELECT value FROM cursorDiskKV
         WHERE key >= ? AND key < ?
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(start, end, maxScan) as Array<{ value: string }>;

    const truncatedScan = rows.length >= maxScan;
    const toolCounts = new Map<string, number>();
    const allBlocks: ThinkingBlock[] = [];
    const analysisTexts: string[] = [];
    let toolCallCount = 0;
    let totalDuration = 0;
    let durationSamples = 0;

    // rows are newest-first; reverse for chronological thinking
    for (const row of rows.slice().reverse()) {
      try {
        const { thinking, toolName } = extractThinkingFromBubble(row.value);
        if (toolName) {
          toolCallCount += 1;
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        }
        if (thinking) {
          allBlocks.push(thinking);
          if (analysisTexts.length < 500) {
            analysisTexts.push(thinking.text.slice(0, 800));
          }
          if (thinking.durationMs != null && thinking.durationMs > 0) {
            totalDuration += thinking.durationMs;
            durationSamples += 1;
          }
        }
      } catch {
        continue;
      }
    }

    const totalChars = allBlocks.reduce((sum, block) => sum + block.charCount, 0);
    const limit = args.limit ?? 40;
    const blocksForReturn = args.includeTexts === false
      ? []
      : allBlocks.slice(-limit).map((block) => ({
          ...block,
          // Keep previews manageable in MCP payloads unless small
          text: block.text.length > 2000 ? `${block.text.slice(0, 2000)}…` : block.text,
        }));

    const longestBlocks = [...allBlocks]
      .sort((a, b) => b.charCount - a.charCount)
      .slice(0, 8)
      .map((block) => ({
        charCount: block.charCount,
        durationMs: block.durationMs,
        preview: block.text.replace(/\s+/g, " ").slice(0, 220),
      }));

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));

    const stats: ThinkingStats = {
      bubbleCount: rows.length,
      thinkingBlockCount: allBlocks.length,
      totalThinkingChars: totalChars,
      totalThinkingDurationMs: totalDuration,
      avgThinkingChars: allBlocks.length ? Math.round(totalChars / allBlocks.length) : 0,
      avgDurationMs: durationSamples ? Math.round(totalDuration / durationSamples) : 0,
      toolCallCount,
      topTools,
      longestBlocks,
    };

    return {
      sessionId: args.sessionId,
      stats,
      blocks: blocksForReturn,
      analysisTexts,
      scannedBubbles: rows.length,
      truncatedScan,
    };
  } finally {
    db.close();
  }
}

function countPattern(texts: string[], pattern: RegExp): number {
  return texts.reduce((sum, text) => sum + (pattern.test(text) ? 1 : 0), 0);
}

export function analyzeThinkingEfficiency(args: {
  stats: ThinkingStats;
  thinkingTexts: string[];
  usage?: {
    chargedCents?: number;
    includedCents?: number;
    onDemandCents?: number;
    eventCount?: number;
    cacheReadTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    models?: string[];
  };
}): EfficiencyInsight[] {
  const insights: EfficiencyInsight[] = [];
  const { stats, thinkingTexts, usage } = args;
  const texts = thinkingTexts;

  if (stats.thinkingBlockCount === 0) {
    insights.push({
      id: "no-thinking",
      severity: "info",
      title: "No local chain-of-thought stored",
      detail:
        "This chat has no thinking.text bubbles. Cost analysis will rely on usage events and tool counts only.",
    });
  }

  if (stats.toolCallCount > 80) {
    insights.push({
      id: "tool-thrash",
      severity: stats.toolCallCount > 200 ? "high" : "warn",
      title: "High tool-loop volume",
      detail: `${stats.toolCallCount} tool calls in this chat. Prefer narrower asks, fewer exploratory greps, and stop once the change is verified.`,
    });
  }

  if (stats.totalThinkingChars > 500_000) {
    insights.push({
      id: "long-cot",
      severity: "warn",
      title: "Very large accumulated thinking",
      detail: `${stats.totalThinkingChars.toLocaleString()} chars of chain-of-thought. Long sessions amplify every later turn via cache/context — split into new chats when the task shifts.`,
    });
  }

  if (usage?.cacheReadTokens && usage.cacheReadTokens > 50_000_000) {
    insights.push({
      id: "cache-bloat",
      severity: "high",
      title: "Massive cache-read usage",
      detail: `${usage.cacheReadTokens.toLocaleString()} cache-read tokens. Context is being re-read every turn. Start a fresh chat for the next sub-task.`,
    });
  }

  if (usage?.eventCount && usage.eventCount > 100) {
    insights.push({
      id: "many-requests",
      severity: "warn",
      title: "Many billed API requests",
      detail: `${usage.eventCount} usage events. Batch decisions, avoid screenshot ping-pong, and reset chat after major milestones.`,
    });
  }

  const retryish = countPattern(
    texts,
    /\b(again|retry|still (broken|failing|wrong)|same error|once more|re-?try)\b/i,
  );
  if (retryish >= 8) {
    insights.push({
      id: "retry-loop",
      severity: "warn",
      title: "Retry / stuck-loop language in thinking",
      detail: `${retryish} thinking blocks mention retries or repeated failures. Pause to form a hypothesis before another tool round.`,
    });
  }

  const exploreish = countPattern(
    texts,
    /\b(search(ing)?|look(ing)? (for|through)|explor(e|ing)|scan(ning)?|find where)\b/i,
  );
  if (exploreish >= 20 && stats.topTools[0]?.name === "Grep") {
    insights.push({
      id: "explore-heavy",
      severity: "info",
      title: "Exploration-heavy thinking",
      detail: `Frequent explore/search thoughts with Grep as top tool (${stats.topTools[0].count}x). Point at exact files/symbols when you know them to cut search turns.`,
    });
  }

  const visual = countPattern(
    texts,
    /\b(screenshot|browser|preview|pixel|layout|css|position|drag|toolbar)\b/i,
  );
  if (visual >= 15) {
    insights.push({
      id: "visual-iteration",
      severity: "info",
      title: "Visual / UI iteration pattern",
      detail: `${visual} thinking blocks reference UI/screenshots/layout. Each visual check can spawn a full agent turn — describe the desired end state once, then ask for a single pass.`,
    });
  }

  const modelSwitch = usage?.models && usage.models.length > 2;
  if (modelSwitch) {
    insights.push({
      id: "model-switch",
      severity: "info",
      title: "Multiple models in one chat",
      detail: `Models used: ${usage.models!.join(", ")}. Switching mid-chat can lose cache and re-pay for context. Prefer one model per chat when possible.`,
    });
  }

  if (usage?.chargedCents && usage.chargedCents > 5000 && stats.thinkingBlockCount > 0) {
    const centsPerThinking = usage.chargedCents / stats.thinkingBlockCount;
    if (centsPerThinking > 5) {
      insights.push({
        id: "expensive-per-thought",
        severity: "warn",
        title: "High cost per thinking block",
        detail: `~$${((centsPerThinking) / 100).toFixed(2)} usage value per thinking bubble. Shorter chats and fewer mid-turn model switches usually help more than shorter thoughts alone.`,
      });
    }
  }

  if (insights.length === 0) {
    insights.push({
      id: "ok",
      severity: "info",
      title: "No strong inefficiency signals",
      detail: "Thinking/tool stats look moderate. Keep chats task-scoped and reset when context gets heavy.",
    });
  }

  return insights;
}

export async function getChatThinkingAnalysis(args: {
  sessionId?: string;
  sessionIndex?: number;
  limit?: number;
  includeTexts?: boolean;
  withUsage?: boolean;
}) {
  let sessionId = args.sessionId;
  let title: string | undefined;
  let sessionIndex: number | undefined = args.sessionIndex;

  if (args.sessionIndex != null) {
    const chat = getChatByIndex(args.sessionIndex, { maxMessages: 1 });
    sessionId = chat.id;
    title = chat.title;
    sessionIndex = chat.sessionIndex;
  } else if (sessionId) {
    sessionIndex = getSessionIndexForId(sessionId);
    if (sessionIndex != null) {
      title = getChatByIndex(sessionIndex, { maxMessages: 1 }).title;
    }
  }

  if (!sessionId) {
    throw new Error("Provide sessionIndex or sessionId.");
  }

  const thinking = loadChatThinking({
    sessionId,
    limit: args.limit ?? 30,
    includeTexts: args.includeTexts !== false,
  });

  let usage:
    | {
        chargedCents: number;
        includedCents: number;
        onDemandCents: number;
        eventCount: number;
        cacheReadTokens: number;
        inputTokens: number;
        outputTokens: number;
        models: string[];
        chargedDollars: string;
        includedDollars: string;
        onDemandDollars: string;
      }
    | undefined;

  if (args.withUsage !== false) {
    try {
      const { getChatUsage } = await import("./chat-usage.js");
      const usageResult = await getChatUsage({ sessionId });
      if (usageResult.usage) {
        usage = {
          chargedCents: usageResult.usage.chargedCents,
          includedCents: usageResult.usage.includedCents,
          onDemandCents: usageResult.usage.onDemandCents,
          eventCount: usageResult.usage.eventCount,
          cacheReadTokens: usageResult.usage.cacheReadTokens,
          inputTokens: usageResult.usage.inputTokens,
          outputTokens: usageResult.usage.outputTokens,
          models: usageResult.usage.models,
          chargedDollars: usageResult.usage.chargedDollars,
          includedDollars: usageResult.usage.includedDollars,
          onDemandDollars: usageResult.usage.onDemandDollars,
        };
      }
    } catch {
      // Usage optional — thinking still useful offline / other account
    }
  }

  const insights = analyzeThinkingEfficiency({
    stats: thinking.stats,
    thinkingTexts: thinking.analysisTexts,
    usage,
  });

  return {
    sessionId,
    sessionIndex,
    title,
    note:
      "Chain-of-thought is local thinking.text from bubbles (not the raw provider prompt). Use insights to cut cost/latency: shorter chats, fewer tool loops, less visual ping-pong.",
    usage,
    stats: thinking.stats,
    insights,
    recentThinking: thinking.blocks,
    scannedBubbles: thinking.scannedBubbles,
    truncatedScan: thinking.truncatedScan,
  };
}

export function thinkingErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
