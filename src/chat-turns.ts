import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

import { getChatByIndex, getSessionIndexForId } from "./history-store.js";

export interface TurnThought {
  index: number;
  charCount: number;
  durationMs: number;
  text: string;
}

export interface TurnToolBucket {
  name: string;
  count: number;
}

export type TurnTimelineEvent =
  | {
      kind: "thought";
      index: number;
      at: string | null;
      durationMs: number;
      charCount: number;
      text: string;
    }
  | {
      kind: "tool";
      index: number;
      at: string | null;
      name: string;
      rawName: string;
      status: string | null;
      toolCallId: string | null;
      params: unknown;
      result: unknown;
      paramsChars: number;
      resultChars: number;
    }
  | {
      kind: "assistant";
      index: number;
      at: string | null;
      charCount: number;
      text: string;
    };

export interface ChatTurn {
  turn: number;
  at: string | null;
  userPreview: string;
  /** Full user message for single-turn deep dives. */
  userText?: string;
  thoughtCount: number;
  thinkChars: number;
  thinkDurationMs: number;
  toolCount: number;
  assistantTextCount: number;
  toolBuckets: TurnToolBucket[];
  /** Tool names in order (may be truncated in list mode). */
  toolSequence: string[];
  thoughts: TurnThought[];
  /** Chronological thought / tool / assistant events (single-turn or when requested). */
  timeline?: TurnTimelineEvent[];
}

interface RawToolFormer {
  name?: string;
  status?: string;
  toolCallId?: string;
  params?: string;
  result?: string;
}

interface RawBubble {
  type?: number;
  text?: string;
  createdAt?: string;
  thinkingDurationMs?: number;
  thinking?: { text?: string };
  toolFormerData?: RawToolFormer;
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

function shortTool(name: string): string {
  return name
    .replace(/_v2$/i, "")
    .replace(/^ripgrep_raw_search$/i, "grep")
    .replace(/^run_terminal_command$/i, "shell")
    .replace(/^glob_file_search$/i, "glob")
    .replace(/^edit_file$/i, "edit")
    .replace(/^read_file$/i, "read")
    .replace(/^read_lints$/i, "lints")
    .replace(/^mcp-cursor-ide-browser-browser_/i, "browser_");
}

function userPreview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (/browser_element/i.test(t)) {
    const tag = t.match(/tag:\s*(\w+)/i)?.[1] ?? "click";
    return `[browser_element] ${tag}`;
  }
  if (/follow-up actions in response to the subagent/i.test(t)) return "[subagent follow-up]";
  if (/task result and perform any follow-up/i.test(t)) return "[task follow-up]";
  const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return (m ? m[1] : t).replace(/\s+/g, " ").trim().slice(0, 200);
}

function toolBuckets(tools: string[]): TurnToolBucket[] {
  const map = new Map<string, number>();
  for (const tool of tools) map.set(tool, (map.get(tool) ?? 0) + 1);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function parseMaybeJson(raw: string | undefined): { value: unknown; chars: number } {
  if (raw == null || raw === "") return { value: null, chars: 0 };
  const chars = raw.length;
  try {
    return { value: JSON.parse(raw) as unknown, chars };
  } catch {
    return { value: raw, chars };
  }
}

function truncateJson(value: unknown, maxChars: number): unknown {
  if (maxChars <= 0 || value == null) return value;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= maxChars) return value;
  if (typeof value === "string") return `${serialized.slice(0, maxChars)}…`;
  return {
    _truncated: true,
    chars: serialized.length,
    preview: `${serialized.slice(0, maxChars)}…`,
  };
}

function isoAt(ms: number): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

export function loadChatTurns(args: {
  sessionId: string;
  /** 1-based turn number; when set, return only that turn with full timeline. */
  turn?: number;
  limit?: number;
  offset?: number;
  /** Include thought text (default true). */
  includeThoughts?: boolean;
  /** Max thoughts returned per turn (default 50; use 0 for all). */
  maxThoughtsPerTurn?: number;
  /** Truncate each thought to this many chars (default 0 = no truncate). */
  maxThoughtChars?: number;
  /** Sort: timeline | tools | thoughts */
  sortBy?: "timeline" | "tools" | "thoughts";
  minTools?: number;
  minThoughts?: number;
  /** Max tool names in toolSequence (default 40). */
  maxToolSequence?: number;
  /** Include chronological timeline (default true when turn= is set). */
  includeTimeline?: boolean;
  /** Include assistant text bubbles in timeline (default true when turn=). */
  includeAssistant?: boolean;
  /** Cap tool params JSON size (0 = full). Default 0 when turn=, else 2000. */
  maxParamChars?: number;
  /** Cap tool result JSON size (0 = full). Default 4000 when turn=, else 500. */
  maxResultChars?: number;
}): {
  sessionId: string;
  turnCount: number;
  returned: number;
  totals: {
    thoughts: number;
    tools: number;
    thinkChars: number;
  };
  turns: ChatTurn[];
} {
  const db = openGlobalDb();
  try {
    const rows = db
      .prepare(
        `SELECT value FROM cursorDiskKV
         WHERE key LIKE ?
         ORDER BY rowid ASC`,
      )
      .all(`bubbleId:${args.sessionId}:%`) as Array<{ value: string }>;

    const bubbles = rows.map((row) => {
      const j = JSON.parse(row.value) as RawBubble;
      const tool = j.toolFormerData?.name
        ? {
            rawName: j.toolFormerData.name,
            name: shortTool(j.toolFormerData.name),
            status: j.toolFormerData.status ?? null,
            toolCallId: j.toolFormerData.toolCallId ?? null,
            paramsRaw: j.toolFormerData.params,
            resultRaw: j.toolFormerData.result,
          }
        : undefined;
      return {
        type: j.type ?? 0,
        createdAt: j.createdAt ? Date.parse(j.createdAt) : 0,
        text: j.text ?? "",
        thinking: j.thinking?.text ?? "",
        thinkDur: j.thinkingDurationMs ?? 0,
        tool,
      };
    });
    bubbles.sort((a, b) => a.createdAt - b.createdAt);

    type RawTurn = {
      at: number;
      userText: string;
      thoughts: Array<{ text: string; durationMs: number; at: number }>;
      tools: Array<{
        name: string;
        rawName: string;
        status: string | null;
        toolCallId: string | null;
        paramsRaw: string | undefined;
        resultRaw: string | undefined;
        at: number;
      }>;
      assistants: Array<{ text: string; at: number }>;
      timelineOrder: Array<
        | { kind: "thought"; i: number }
        | { kind: "tool"; i: number }
        | { kind: "assistant"; i: number }
      >;
    };

    const rawTurns: RawTurn[] = [];
    let current: RawTurn | null = null;

    for (const bubble of bubbles) {
      if (bubble.type === 1) {
        if (current) rawTurns.push(current);
        current = {
          at: bubble.createdAt,
          userText: bubble.text,
          thoughts: [],
          tools: [],
          assistants: [],
          timelineOrder: [],
        };
        continue;
      }
      if (!current) continue;

      if (bubble.thinking) {
        const i = current.thoughts.length;
        current.thoughts.push({
          text: bubble.thinking,
          durationMs: bubble.thinkDur,
          at: bubble.createdAt,
        });
        current.timelineOrder.push({ kind: "thought", i });
      }
      if (bubble.tool) {
        const i = current.tools.length;
        current.tools.push({ ...bubble.tool, at: bubble.createdAt });
        current.timelineOrder.push({ kind: "tool", i });
      }
      if (bubble.text.trim() && !bubble.tool) {
        const i = current.assistants.length;
        current.assistants.push({ text: bubble.text, at: bubble.createdAt });
        current.timelineOrder.push({ kind: "assistant", i });
      }
    }
    if (current) rawTurns.push(current);

    const singleTurn = args.turn != null;
    const includeThoughts = args.includeThoughts !== false;
    const includeTimeline = args.includeTimeline ?? singleTurn;
    const includeAssistant = args.includeAssistant ?? singleTurn;
    const maxThoughts = args.maxThoughtsPerTurn ?? (singleTurn ? 0 : 50);
    const maxThoughtChars = args.maxThoughtChars ?? 0;
    const maxToolSequence = args.maxToolSequence ?? (singleTurn ? 0 : 40);
    const maxParamChars = args.maxParamChars ?? (singleTurn ? 0 : 2000);
    const maxResultChars = args.maxResultChars ?? (singleTurn ? 4000 : 500);

    const buildThoughts = (turn: RawTurn): TurnThought[] => {
      let thoughts: TurnThought[] = turn.thoughts.map((thought, thoughtIndex) => {
        let text = thought.text;
        if (maxThoughtChars > 0 && text.length > maxThoughtChars) {
          text = `${text.slice(0, maxThoughtChars)}…`;
        }
        return {
          index: thoughtIndex + 1,
          charCount: thought.text.length,
          durationMs: thought.durationMs,
          text: includeThoughts ? text : text.replace(/\s+/g, " ").slice(0, 120),
        };
      });

      if (maxThoughts > 0 && thoughts.length > maxThoughts) {
        const head = Math.ceil(maxThoughts / 2);
        const tail = maxThoughts - head;
        thoughts = [...thoughts.slice(0, head), ...thoughts.slice(-tail)];
      }
      return thoughts;
    };

    const buildTimeline = (turn: RawTurn): TurnTimelineEvent[] => {
      const events: TurnTimelineEvent[] = [];
      let thoughtN = 0;
      let toolN = 0;
      let assistantN = 0;

      for (const step of turn.timelineOrder) {
        if (step.kind === "thought") {
          const thought = turn.thoughts[step.i]!;
          thoughtN += 1;
          let text = thought.text;
          if (maxThoughtChars > 0 && text.length > maxThoughtChars) {
            text = `${text.slice(0, maxThoughtChars)}…`;
          }
          events.push({
            kind: "thought",
            index: thoughtN,
            at: isoAt(thought.at),
            durationMs: thought.durationMs,
            charCount: thought.text.length,
            text,
          });
        } else if (step.kind === "tool") {
          const tool = turn.tools[step.i]!;
          toolN += 1;
          const parsedParams = parseMaybeJson(tool.paramsRaw);
          const parsedResult = parseMaybeJson(tool.resultRaw);
          events.push({
            kind: "tool",
            index: toolN,
            at: isoAt(tool.at),
            name: tool.name,
            rawName: tool.rawName,
            status: tool.status,
            toolCallId: tool.toolCallId,
            params: truncateJson(parsedParams.value, maxParamChars),
            result: truncateJson(parsedResult.value, maxResultChars),
            paramsChars: parsedParams.chars,
            resultChars: parsedResult.chars,
          });
        } else if (includeAssistant) {
          const assistant = turn.assistants[step.i]!;
          assistantN += 1;
          let text = assistant.text;
          if (maxThoughtChars > 0 && text.length > maxThoughtChars) {
            text = `${text.slice(0, maxThoughtChars)}…`;
          }
          events.push({
            kind: "assistant",
            index: assistantN,
            at: isoAt(assistant.at),
            charCount: assistant.text.length,
            text,
          });
        }
      }
      return events;
    };

    let turns: ChatTurn[] = rawTurns.map((turn, index) => {
      const toolNames = turn.tools.map((t) => t.name);
      const seqLimit = maxToolSequence > 0 ? maxToolSequence : toolNames.length;
      const out: ChatTurn = {
        turn: index + 1,
        at: isoAt(turn.at),
        userPreview: userPreview(turn.userText),
        thoughtCount: turn.thoughts.length,
        thinkChars: turn.thoughts.reduce((n, t) => n + t.text.length, 0),
        thinkDurationMs: turn.thoughts.reduce((n, t) => n + t.durationMs, 0),
        toolCount: turn.tools.length,
        assistantTextCount: turn.assistants.length,
        toolBuckets: toolBuckets(toolNames),
        toolSequence: toolNames.slice(0, seqLimit),
        thoughts: includeThoughts ? buildThoughts(turn) : [],
      };
      if (includeTimeline) {
        out.timeline = buildTimeline(turn);
        out.userText = turn.userText;
      }
      return out;
    });

    if (args.turn != null) {
      turns = turns.filter((t) => t.turn === args.turn);
    } else {
      if (args.minTools != null) turns = turns.filter((t) => t.toolCount >= args.minTools!);
      if (args.minThoughts != null) {
        turns = turns.filter((t) => t.thoughtCount >= args.minThoughts!);
      }

      const sortBy = args.sortBy ?? "timeline";
      turns = [...turns].sort((a, b) => {
        if (sortBy === "tools") return b.toolCount - a.toolCount;
        if (sortBy === "thoughts") return b.thoughtCount - a.thoughtCount;
        return a.turn - b.turn;
      });

      const offset = args.offset ?? 0;
      const limit = args.limit ?? 20;
      turns = turns.slice(offset, offset + limit);
    }

    const totals = {
      thoughts: rawTurns.reduce((n, t) => n + t.thoughts.length, 0),
      tools: rawTurns.reduce((n, t) => n + t.tools.length, 0),
      thinkChars: rawTurns.reduce(
        (n, t) => n + t.thoughts.reduce((m, th) => m + th.text.length, 0),
        0,
      ),
    };

    return {
      sessionId: args.sessionId,
      turnCount: rawTurns.length,
      returned: turns.length,
      totals,
      turns,
    };
  } finally {
    db.close();
  }
}

export function getChatTurns(args: {
  sessionId?: string;
  sessionIndex?: number;
  turn?: number;
  limit?: number;
  offset?: number;
  includeThoughts?: boolean;
  maxThoughtsPerTurn?: number;
  maxThoughtChars?: number;
  sortBy?: "timeline" | "tools" | "thoughts";
  minTools?: number;
  minThoughts?: number;
  maxToolSequence?: number;
  includeTimeline?: boolean;
  includeAssistant?: boolean;
  maxParamChars?: number;
  maxResultChars?: number;
}) {
  let sessionId = args.sessionId;
  let title: string | undefined;
  let sessionIndex = args.sessionIndex;

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
  if (!sessionId) throw new Error("Provide sessionIndex or sessionId.");

  const result = loadChatTurns({
    sessionId,
    turn: args.turn,
    limit: args.limit,
    offset: args.offset,
    includeThoughts: args.includeThoughts,
    maxThoughtsPerTurn: args.turn != null ? args.maxThoughtsPerTurn ?? 0 : args.maxThoughtsPerTurn,
    maxThoughtChars: args.maxThoughtChars,
    sortBy: args.sortBy,
    minTools: args.minTools,
    minThoughts: args.minThoughts,
    maxToolSequence: args.maxToolSequence,
    includeTimeline: args.includeTimeline,
    includeAssistant: args.includeAssistant,
    maxParamChars: args.maxParamChars,
    maxResultChars: args.maxResultChars,
  });

  return {
    ...result,
    sessionId,
    sessionIndex,
    title,
    note:
      "Literal local chain-of-thought (thinking.text) and tool calls in chronological timeline. No scoring — raw material for another agent to analyze.",
  };
}

export function chatTurnsErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
