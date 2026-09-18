import { loadChatTurns } from "./chat-turns.js";
import { runAgentCliPrompt } from "./agent-cli.js";
import { THEME_BUCKETS } from "./atlas-themes.js";

export interface RawSegment {
  turnStart: number;
  turnEnd: number;
  themeLabel: string;
  preview: string;
  category?: string;
}

export interface ParsedSegment extends RawSegment {
  id: string;
  themeId: string;
}

const SEGMENT_JSON_RE = /\[[\s\S]*\]/;

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "misc";
}

export function themeIdFromLabel(label: string): string {
  return slugify(label);
}

function buildTranscript(sessionId: string, maxTurns = 40): string {
  const { turns } = loadChatTurns({
    sessionId,
    limit: maxTurns,
    includeThoughts: false,
    includeTimeline: false,
    maxToolSequence: 8,
  });
  if (turns.length === 0) return "";

  return turns
    .map((t) => {
      const assistantBits = t.toolCount
        ? ` [${t.toolCount} tools: ${t.toolSequence.slice(0, 5).join(", ")}]`
        : "";
      return `Turn ${t.turn} (user): ${t.userPreview}${assistantBits}`;
    })
    .join("\n");
}

function parseSegmentJson(text: string): RawSegment[] {
  const match = text.match(SEGMENT_JSON_RE);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    const rows: Array<RawSegment | null> = parsed.map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        const turnStart = Number(r.turnStart);
        const turnEnd = Number(r.turnEnd);
        const themeLabel = String(r.themeLabel ?? r.theme ?? "").trim();
        const preview = String(r.preview ?? r.summary ?? "").trim();
        const category = String(r.category ?? "").trim();
        if (!Number.isFinite(turnStart) || !Number.isFinite(turnEnd) || !themeLabel) return null;
        const seg: RawSegment = {
          turnStart: Math.max(1, Math.floor(turnStart)),
          turnEnd: Math.max(Math.floor(turnEnd), Math.floor(turnStart)),
          themeLabel,
          preview: preview.slice(0, 280),
        };
        if (category) seg.category = category;
        return seg;
      });
    return rows.filter((x): x is RawSegment => x !== null);
  } catch {
    return [];
  }
}

export function heuristicSegments(sessionId: string): ParsedSegment[] {
  const { turns } = loadChatTurns({
    sessionId,
    limit: 500,
    includeThoughts: false,
    includeTimeline: false,
  });
  return turns.map((t) => {
    const themeLabel = t.userPreview.slice(0, 48) || `Turn ${t.turn}`;
    const themeId = themeIdFromLabel(themeLabel);
    return {
      id: `${sessionId.slice(0, 8)}-t${t.turn}`,
      turnStart: t.turn,
      turnEnd: t.turn,
      themeLabel,
      themeId,
      preview: t.userPreview.slice(0, 200),
    };
  });
}

export async function llmSegments(args: {
  sessionId: string;
  title: string;
  workspace?: string;
  cwd: string;
  model?: string;
}): Promise<ParsedSegment[]> {
  const transcript = buildTranscript(args.sessionId);
  if (!transcript) return heuristicSegments(args.sessionId);

  const workspaceLabel = args.workspace?.split(/[/\\]/).pop() ?? "unknown";
  const prompt = `You segment Cursor IDE chat transcripts into topic threads.

Chat title: ${args.title}
Workspace folder: ${workspaceLabel}

Return ONLY a JSON array (no markdown fences). Each item:
{"turnStart": number, "turnEnd": number, "themeLabel": "short topic name", "preview": "one-line gist", "category": "one of: faciliq-relate | cursor-tooling | research | personal | other"}

Rules:
- turnStart/turnEnd are 1-based user turn numbers (inclusive)
- Adjacent turns about the same work should share one segment
- themeLabel: 2-5 words describing the TOPIC (e.g. "chiptune audio FX", "formula scheduling", "PR dark mode review") — short, reusable across chats. NOT a product name unless the chat is actually about that product
- category: pick the best bucket. Use faciliq-relate ONLY for Faciliq/Relate/Yardi/MyPlace work. Use personal for side projects, games, audio, macOS setup. Do NOT label unrelated chats faciliq-relate just because someone said "deploy".
- preview: what happened in this segment (max 120 chars)
- Cover all turns in the transcript

Transcript:
${transcript}`;

  try {
    const result = await runAgentCliPrompt({
      prompt,
      cwd: args.cwd,
      mode: "ask",
      model: args.model ?? "auto",
    });
    const raw = parseSegmentJson(result.result);
    if (raw.length === 0) return heuristicSegments(args.sessionId);
    return raw.map((seg, i) => {
      const categoryBucket = THEME_BUCKETS.find((b) => b.id === seg.category);
      return {
        ...seg,
        id: `${args.sessionId.slice(0, 8)}-s${i + 1}`,
        themeId: categoryBucket?.id ?? themeIdFromLabel(seg.themeLabel),
      };
    });
  } catch {
    return heuristicSegments(args.sessionId);
  }
}
