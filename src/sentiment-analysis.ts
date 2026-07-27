import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { getSessionIndexForId, listChatSummaries } from "./history-store.js";

export interface SentimentScores {
  valence: number;
  frustration: number;
  confusion: number;
  satisfaction: number;
  label: string;
  wordCount: number;
}

export interface SentimentMessageHit extends SentimentScores {
  msgIndex: number;
  text: string;
  afterClaimedDone: boolean;
  sessionIndex: number;
  title: string;
  updatedAt: string;
  workspace: string;
  fullText?: string;
  priorAssistantTail?: string | null;
}

export interface SentimentSessionSummary {
  sessionIndex: number;
  sessionId: string;
  title: string;
  workspace: string;
  updatedAt: string;
  userMessageCount: number;
  avgValence: number;
  avgFrustration: number;
  avgConfusion: number;
  avgSatisfaction: number;
  peakFrustration: { score: number; text: string };
  escalating: boolean;
  labelCounts: Record<string, number>;
}

export interface SentimentAnalysisParams {
  workspace?: string;
  sessionIndex?: number;
  topMessages?: number;
  topSessions?: number;
  includeClassificationInput?: boolean;
}

export interface SentimentAnalysisReport {
  generatedAt: string;
  method: string;
  totals: {
    sessions: number;
    userMessages: number;
    labels: Record<string, number>;
  };
  global: {
    valence: number;
    frustration: number;
    confusion: number;
    satisfaction: number;
  };
  monthlyTrend: Record<
    string,
    {
      n: number;
      avgFrustration: number;
      avgValence: number;
      avgConfusion: number;
    }
  >;
  topFrustratedMessages: SentimentMessageHit[];
  afterAssistantClaimedDone: SentimentMessageHit[];
  hardestSessions: SentimentSessionSummary[];
  escalatingSessions: SentimentSessionSummary[];
  forClassification?: Array<{
    sessionIndex: number;
    title: string;
    updatedAt: string;
    msgIndex: number;
    text: string;
    scores: Pick<SentimentScores, "frustration" | "confusion" | "satisfaction" | "valence" | "label">;
    afterClaimedDone: boolean;
    priorAssistantTail: string | null;
    workspace: string;
  }>;
}

type Pattern = [RegExp, number];

const FRUSTRATION: Pattern[] = [
  [/\b(frustrat(ed|ing|ion)|annoy(ed|ing)|pissed|fed up|infuriating)\b/i, 0.95],
  [/\b(still not working|still broken|doesn't work|didn't work|not working|broken again)\b/i, 0.85],
  [/\b(maybe we just can|give up|forget it|never mind|nevermind)\b/i, 0.9],
  [/\b(that didn't work|didn't work either|stop doing|not what i (asked|wanted|meant))\b/i, 0.8],
  [/\byou keep (getting|doing|trying|failing|missing|breaking)\b/i, 0.8],
  [/\b(you (didn't|got it wrong|are wrong)|that's wrong|this is wrong|not right|thats not right|you didnt|didnt mirror)\b/i, 0.75],
  [/\b(what's wrong|why won't|why doesn't|why isn't|why cant|why can't|still getting it wrong|whats wrong)\b/i, 0.55],
  [/\b(ugh|wtf|ffs|come on|seriously\?|ridiculous|useless|terrible|awful|bad job)\b/i, 0.85],
  [/:\/\s*$/i, 0.65],
  [/\b(still)\b/i, 0.45],
  [/\b(again\??|once more|same (issue|problem|error))\b/i, 0.4],
];

const CONFUSION: Pattern[] = [
  [/\bi'm confused\b/i, 0.85],
  [/\b(i dont understand|i don't understand|doesn't make sense|not sure i follow)\b/i, 0.8],
  [/\b(wait\.\.\.|hang on|hold on)\b/i, 0.45],
  [/\b(confused about|unclear|unclear on)\b/i, 0.7],
  [/\bwhy (would|does|is|are|do|can)\b/i, 0.35],
];

const SATISFACTION: Pattern[] = [
  [/\b(thanks|thank you|perfect|exactly|great job|awesome|love it|works now|lgtm|ship it|well done)\b/i, 0.65],
  [/\b(nice|good|cool|alright!|got it|works|fixed)\b/i, 0.35],
];

const DIRECTIVE =
  /^\s*(implement|create|add|fix|update|remove|delete|build|make|run|commit|push|deploy|write|refactor|move|rename|split|merge|search|look at|show me|give me|explain|help me|can you|could you|please|sure|yes|ok|okay|go ahead|do it|continue|proceed)/i;

function globalDbFile(): string {
  const override = process.env.CURSOR_META_STATE_DB;
  if (override) return override;
  return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
}

export function stripMessageText(text: string): string {
  return text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")
    .replace(/<user_query>\s*/g, "")
    .replace(/\s*<\/user_query>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSystemNoise(text: string): boolean {
  const head = text.slice(0, 800);
  return (
    /The following task has finished/i.test(head) ||
    /kind: subagent\b/i.test(head) ||
    /tool_call_id:/i.test(head) ||
    /^<\/?response>/i.test(text) ||
    /^output_path:/i.test(text)
  );
}

function scorePatterns(text: string, patterns: Pattern[]): number {
  let score = 0;
  for (const [re, weight] of patterns) {
    if (re.test(text)) score = Math.max(score, weight);
  }
  return score;
}

export function priorClaimedDone(prevAssistant: string | null | undefined): boolean {
  if (!prevAssistant) return false;
  const tail = prevAssistant.toLowerCase().slice(-500);
  return (
    /\b(fixed|done|complete|deployed|published|should work|ready|resolved|success|updated|committed|pushed)\b/.test(
      tail,
    ) && !/\b(not yet|can't|cannot|unable|failed|error|didn't work)\b/.test(tail)
  );
}

export function analyzeUserMessage(
  text: string,
  ctx: { afterClaimedDone: boolean; userMsgIndex: number; raw: string },
): SentimentScores {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  let frustration = scorePatterns(trimmed, FRUSTRATION);
  let confusion = scorePatterns(trimmed, CONFUSION);
  let satisfaction = scorePatterns(trimmed, SATISFACTION);
  const isDirective = DIRECTIVE.test(trimmed);

  if (wordCount <= 3 && /\b(still|broken|wrong|no|nope|why)\b/i.test(trimmed)) {
    frustration = Math.max(frustration, 0.75);
  }
  if (/^still\.?$/i.test(trimmed)) frustration = Math.max(frustration, 0.92);
  if (ctx.afterClaimedDone && (frustration > 0.2 || /\b(still|but|wrong|not)\b/i.test(trimmed))) {
    frustration = Math.min(1, frustration + 0.25);
  }
  if (ctx.userMsgIndex >= 5 && wordCount < 80 && frustration > 0.25) {
    frustration = Math.min(1, frustration + 0.1);
  }
  if (/\[Image\]|browser_element|screenshot/i.test(ctx.raw) && wordCount < 120) {
    frustration = Math.min(1, frustration + 0.08);
  }

  if (isDirective && wordCount > 30 && frustration < 0.5) frustration *= 0.45;
  if (/do not edit the plan file|don't stop until|implement the plan/i.test(trimmed)) frustration *= 0.15;
  if (/figured it out.*nevermind|nevermind.*figured it out/i.test(trimmed)) {
    frustration = 0.05;
    satisfaction = Math.max(satisfaction, 0.5);
  }
  if (/^nevermind on/i.test(trimmed)) frustration = Math.min(frustration, 0.2);
  if (/\b(keep chugging|keep going|carry on)\b/i.test(trimmed) && !/\b(broken|wrong|not working)\b/i.test(trimmed)) {
    frustration = Math.min(frustration, 0.1);
  }
  if (/\beverytime i was frustrated\b|\bsentiment analysis\b/i.test(trimmed)) {
    frustration = Math.min(frustration, 0.15);
  }
  if (
    /\b(but we should still|should still|i still want|still do the)\b/i.test(trimmed) &&
    !/\b(broken|wrong|not working|hang|fail)\b/i.test(trimmed)
  ) {
    frustration *= 0.35;
  }
  if (/grill me|begin grill/i.test(trimmed)) confusion = Math.max(confusion, 0.25);

  const valence = Math.max(-1, Math.min(1, satisfaction * 0.9 - frustration * 0.95 - confusion * 0.35));
  const label =
    satisfaction > 0.55 && frustration < 0.35
      ? "positive"
      : frustration >= 0.7
        ? "frustrated"
        : frustration >= 0.45
          ? "negative"
          : confusion >= 0.55
            ? "confused"
            : isDirective && wordCount > 8
              ? "neutral_directive"
              : frustration >= 0.3 || confusion >= 0.4
                ? "mild_negative"
                : satisfaction >= 0.35
                  ? "mild_positive"
                  : "neutral";

  return {
    valence: +valence.toFixed(3),
    frustration: +frustration.toFixed(3),
    confusion: +confusion.toFixed(3),
    satisfaction: +satisfaction.toFixed(3),
    label,
    wordCount,
  };
}

interface ThreadMessage {
  role: "user" | "assistant";
  text: string;
  raw: string;
}

export function runSentimentAnalysis(params: SentimentAnalysisParams = {}): SentimentAnalysisReport {
  const db = new Database(globalDbFile(), { readonly: true });
  try {
    const headers = db
      .prepare(
        `SELECT composerId, value, lastUpdatedAt FROM composerHeaders
         WHERE IFNULL(isSubagent,0)=0 ORDER BY lastUpdatedAt DESC`,
      )
      .all() as Array<{ composerId: string; value: string; lastUpdatedAt: number }>;

    const meta = new Map<
      string,
      { sessionIndex: number; title: string; workspace: string; updatedAt: string }
    >();
    headers.forEach((header, index) => {
      let parsed: {
        name?: string;
        workspaceIdentifier?: { uri?: { fsPath?: string; path?: string }; id?: string };
      } = {};
      try {
        parsed = JSON.parse(header.value);
      } catch {
        parsed = {};
      }
      meta.set(header.composerId, {
        sessionIndex: index + 1,
        title: parsed.name ?? "(untitled)",
        workspace:
          parsed.workspaceIdentifier?.uri?.fsPath ??
          parsed.workspaceIdentifier?.uri?.path ??
          parsed.workspaceIdentifier?.id ??
          "unknown",
        updatedAt: new Date(header.lastUpdatedAt).toISOString().slice(0, 10),
      });
    });

    const bubbles = db
      .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid ASC`)
      .all() as Array<{ key: string; value: string }>;

    const threads = new Map<string, ThreadMessage[]>();
    for (const row of bubbles) {
      const sessionId = row.key.split(":")[1];
      if (!sessionId || !meta.has(sessionId)) continue;
      try {
        const bubble = JSON.parse(row.value) as { type?: number; text?: string };
        const raw = bubble.text ?? "";
        const text = stripMessageText(raw);
        if (!text || isSystemNoise(text)) continue;
        if (!threads.has(sessionId)) threads.set(sessionId, []);
        threads.get(sessionId)!.push({
          role: bubble.type === 2 ? "assistant" : "user",
          text,
          raw,
        });
      } catch {
        continue;
      }
    }

    const sessions: SentimentSessionSummary[] = [];
    const allUserMsgs: SentimentMessageHit[] = [];

    for (const [sessionId, thread] of threads) {
      const sessionMeta = meta.get(sessionId)!;
      if (params.workspace && !sessionMeta.workspace.includes(params.workspace)) continue;
      if (params.sessionIndex != null && sessionMeta.sessionIndex !== params.sessionIndex) continue;

      const userMsgs: Array<SentimentScores & { msgIndex: number; text: string; afterClaimedDone: boolean }> =
        [];
      let userIdx = 0;
      for (let i = 0; i < thread.length; i += 1) {
        if (thread[i].role !== "user") continue;
        userIdx += 1;
        let prevAssistant: string | null = null;
        for (let j = i - 1; j >= 0; j -= 1) {
          if (thread[j].role === "assistant") {
            prevAssistant = thread[j].text;
            break;
          }
        }
        const afterClaimedDone = priorClaimedDone(prevAssistant);
        const scores = analyzeUserMessage(thread[i].text, {
          afterClaimedDone,
          userMsgIndex: userIdx,
          raw: thread[i].raw,
        });
        const item = {
          msgIndex: userIdx,
          text: thread[i].text.slice(0, 280),
          afterClaimedDone,
          ...scores,
        };
        userMsgs.push(item);
        allUserMsgs.push({
          ...item,
          sessionIndex: sessionMeta.sessionIndex,
          title: sessionMeta.title,
          updatedAt: sessionMeta.updatedAt,
          workspace: sessionMeta.workspace,
          fullText: thread[i].text,
          priorAssistantTail: prevAssistant ? prevAssistant.slice(-400) : null,
        });
      }
      if (!userMsgs.length) continue;

      const avg = (key: keyof SentimentScores) =>
        userMsgs.reduce((sum, message) => sum + (message[key] as number), 0) / userMsgs.length;
      const peakFrustration = userMsgs.reduce((best, message) =>
        message.frustration > best.frustration ? message : best,
      );
      const half = Math.ceil(userMsgs.length / 2);
      const avgFirst =
        userMsgs.slice(0, half).reduce((sum, message) => sum + message.frustration, 0) / half;
      const avgSecond =
        userMsgs.slice(half).reduce((sum, message) => sum + message.frustration, 0) /
        (userMsgs.length - half || 1);

      const labelCounts: Record<string, number> = {};
      for (const message of userMsgs) {
        labelCounts[message.label] = (labelCounts[message.label] ?? 0) + 1;
      }

      sessions.push({
        sessionIndex: sessionMeta.sessionIndex,
        sessionId,
        title: sessionMeta.title,
        workspace: sessionMeta.workspace,
        updatedAt: sessionMeta.updatedAt,
        userMessageCount: userMsgs.length,
        avgValence: +avg("valence").toFixed(3),
        avgFrustration: +avg("frustration").toFixed(3),
        avgConfusion: +avg("confusion").toFixed(3),
        avgSatisfaction: +avg("satisfaction").toFixed(3),
        peakFrustration: { score: peakFrustration.frustration, text: peakFrustration.text },
        escalating: userMsgs.length >= 4 && avgSecond - avgFirst >= 0.15,
        labelCounts,
      });
    }

    const labelDist: Record<string, number> = {};
    for (const message of allUserMsgs) {
      labelDist[message.label] = (labelDist[message.label] ?? 0) + 1;
    }

    const topMessages = params.topMessages ?? 40;
    const topSessions = params.topSessions ?? 20;

    const frustratedMsgs = allUserMsgs
      .filter((message) => message.frustration >= 0.55)
      .sort((a, b) => b.frustration - a.frustration);

    const afterDoneFails = allUserMsgs
      .filter((message) => message.afterClaimedDone && message.frustration >= 0.45)
      .sort((a, b) => b.frustration - a.frustration);

    const hardest = sessions
      .filter((session) => session.avgFrustration >= 0.32 || session.peakFrustration.score >= 0.65)
      .sort((a, b) => b.avgFrustration - a.avgFrustration);

    const byMonth: Record<string, { n: number; fr: number; val: number; conf: number }> = {};
    for (const session of sessions) {
      const month = session.updatedAt.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = { n: 0, fr: 0, val: 0, conf: 0 };
      const bucket = byMonth[month];
      bucket.n += 1;
      bucket.fr += session.avgFrustration;
      bucket.val += session.avgValence;
      bucket.conf += session.avgConfusion;
    }
    const monthlyTrend: SentimentAnalysisReport["monthlyTrend"] = {};
    for (const month of Object.keys(byMonth)) {
      const bucket = byMonth[month];
      monthlyTrend[month] = {
        n: bucket.n,
        avgFrustration: +(bucket.fr / bucket.n).toFixed(3),
        avgValence: +(bucket.val / bucket.n).toFixed(3),
        avgConfusion: +(bucket.conf / bucket.n).toFixed(3),
      };
    }

    const qualifyingForClassification = allUserMsgs
      .filter((message) => message.frustration >= 0.45)
      .sort((a, b) => b.frustration - a.frustration);
    const classificationSource =
      qualifyingForClassification.length >= 100
        ? qualifyingForClassification.slice(0, 100)
        : [...allUserMsgs].sort((a, b) => b.frustration - a.frustration).slice(0, 100);

    const report: SentimentAnalysisReport = {
      generatedAt: new Date().toISOString(),
      method:
        "Multi-axis scoring: valence, frustration, confusion, satisfaction. Context-aware (reacts after assistant 'done' claims, thread depth, terse follow-ups).",
      totals: {
        sessions: sessions.length,
        userMessages: allUserMsgs.length,
        labels: labelDist,
      },
      global: allUserMsgs.length
        ? {
            valence: +(allUserMsgs.reduce((sum, message) => sum + message.valence, 0) / allUserMsgs.length).toFixed(3),
            frustration: +(
              allUserMsgs.reduce((sum, message) => sum + message.frustration, 0) / allUserMsgs.length
            ).toFixed(3),
            confusion: +(
              allUserMsgs.reduce((sum, message) => sum + message.confusion, 0) / allUserMsgs.length
            ).toFixed(3),
            satisfaction: +(
              allUserMsgs.reduce((sum, message) => sum + message.satisfaction, 0) / allUserMsgs.length
            ).toFixed(3),
          }
        : { valence: 0, frustration: 0, confusion: 0, satisfaction: 0 },
      monthlyTrend,
      topFrustratedMessages: frustratedMsgs.slice(0, topMessages),
      afterAssistantClaimedDone: afterDoneFails.slice(0, 25),
      hardestSessions: hardest.slice(0, topSessions),
      escalatingSessions: sessions
        .filter((session) => session.escalating)
        .sort((a, b) => b.avgFrustration - a.avgFrustration)
        .slice(0, 15),
    };

    if (params.includeClassificationInput) {
      report.forClassification = classificationSource.map((message) => ({
        sessionIndex: message.sessionIndex,
        title: message.title,
        updatedAt: message.updatedAt,
        msgIndex: message.msgIndex,
        text: message.fullText ?? message.text,
        scores: {
          frustration: message.frustration,
          confusion: message.confusion,
          satisfaction: message.satisfaction,
          valence: message.valence,
          label: message.label,
        },
        afterClaimedDone: message.afterClaimedDone,
        priorAssistantTail: message.priorAssistantTail ?? null,
        workspace: message.workspace,
      }));
    }

    return report;
  } finally {
    db.close();
  }
}

export function resolveSentimentSessionIndex(sessionIndex?: number, sessionId?: string): number | undefined {
  if (sessionIndex != null) return sessionIndex;
  if (sessionId) return getSessionIndexForId(sessionId);
  return undefined;
}

export function listSentimentSessionOptions(limit = 20): Array<{
  sessionIndex: number;
  title: string;
  workspace: string;
}> {
  const { sessions } = listChatSummaries({ limit });
  return sessions.map((session) => ({
    sessionIndex: session.sessionIndex,
    title: session.title,
    workspace: session.workspace,
  }));
}
