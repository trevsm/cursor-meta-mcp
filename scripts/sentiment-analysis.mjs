#!/usr/bin/env node
/** Fast multi-axis sentiment analysis — single DB pass. */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(process.cwd(), "sentiment-report.json");
const CLASSIFY_OUT =
  process.argv[3] ?? join(OUT.replace(/[^/]+$/, ""), "sentiment-classify-input.json");

const FRUSTRATION = [
  [/\b(frustrat(ed|ing|ion)|annoy(ed|ing)|pissed|fed up|infuriating)\b/i, 0.95],
  [/\b(still not working|still broken|doesn't work|doesn't work|didn't work|not working|broken again)\b/i, 0.85],
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

const CONFUSION = [
  [/\bi'm confused\b/i, 0.85],
  [/\b(i dont understand|i don't understand|doesn't make sense|not sure i follow)\b/i, 0.8],
  [/\b(wait\.\.\.|hang on|hold on)\b/i, 0.45],
  [/\b(confused about|unclear|unclear on)\b/i, 0.7],
  [/\bwhy (would|does|is|are|do|can)\b/i, 0.35],
];

const SATISFACTION = [
  [/\b(thanks|thank you|perfect|exactly|great job|awesome|love it|works now|lgtm|ship it|well done)\b/i, 0.65],
  [/\b(nice|good|cool|alright!|got it|works|fixed)\b/i, 0.35],
];

const DIRECTIVE =
  /^\s*(implement|create|add|fix|update|remove|delete|build|make|run|commit|push|deploy|write|refactor|move|rename|split|merge|search|look at|show me|give me|explain|help me|can you|could you|please|sure|yes|ok|okay|go ahead|do it|continue|proceed)/i;

function strip(text) {
  return text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")
    .replace(/<user_query>\s*/g, "")
    .replace(/\s*<\/user_query>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSystemNoise(text) {
  const head = text.slice(0, 800);
  return (
    /The following task has finished/i.test(head) ||
    /kind: subagent\b/i.test(head) ||
    /tool_call_id:/i.test(head) ||
    /^<\/?response>/i.test(text) ||
    /^output_path:/i.test(text)
  );
}

function scorePatterns(text, patterns) {
  let score = 0;
  for (const [re, w] of patterns) if (re.test(text)) score = Math.max(score, w);
  return score;
}

function priorClaimedDone(prevAsst) {
  if (!prevAsst) return false;
  const t = prevAsst.toLowerCase();
  const tail = t.slice(-500);
  return (
    /\b(fixed|done|complete|deployed|published|should work|ready|resolved|success|updated|committed|pushed)\b/.test(tail) &&
    !/\b(not yet|can't|cannot|unable|failed|error|didn't work)\b/.test(tail)
  );
}

function analyze(text, ctx) {
  const t = text.trim();
  const wc = t.split(/\s+/).filter(Boolean).length;
  let frustration = scorePatterns(t, FRUSTRATION);
  let confusion = scorePatterns(t, CONFUSION);
  let satisfaction = scorePatterns(t, SATISFACTION);
  const isDirective = DIRECTIVE.test(t);

  if (wc <= 3 && /\b(still|broken|wrong|no|nope|why)\b/i.test(t)) frustration = Math.max(frustration, 0.75);
  if (/^still\.?$/i.test(t)) frustration = Math.max(frustration, 0.92);
  if (ctx.afterClaimedDone && (frustration > 0.2 || /\b(still|but|wrong|not)\b/i.test(t)))
    frustration = Math.min(1, frustration + 0.25);
  if (ctx.userMsgIndex >= 5 && wc < 80 && frustration > 0.25) frustration = Math.min(1, frustration + 0.1);
  if (/\[Image\]|browser_element|screenshot/i.test(ctx.raw) && wc < 120)
    frustration = Math.min(1, frustration + 0.08);

  if (isDirective && wc > 30 && frustration < 0.5) frustration *= 0.45;
  if (/do not edit the plan file|don't stop until|implement the plan/i.test(t)) frustration *= 0.15;
  if (/figured it out.*nevermind|nevermind.*figured it out/i.test(t)) {
    frustration = 0.05;
    satisfaction = Math.max(satisfaction, 0.5);
  }
  if (/^nevermind on/i.test(t)) frustration = Math.min(frustration, 0.2);
  if (/\b(keep chugging|keep going|carry on)\b/i.test(t) && !/\b(broken|wrong|not working)\b/i.test(t))
    frustration = Math.min(frustration, 0.1);
  if (/\beverytime i was frustrated\b|\bsentiment analysis\b/i.test(t)) frustration = Math.min(frustration, 0.15);
  if (
    /\b(but we should still|should still|i still want|still do the)\b/i.test(t) &&
    !/\b(broken|wrong|not working|hang|fail)\b/i.test(t)
  )
    frustration *= 0.35;
  if (/grill me|begin grill/i.test(t)) confusion = Math.max(confusion, 0.25);

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
            : isDirective && wc > 8
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
    wordCount: wc,
  };
}

function main() {
  const dbPath = join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  const db = new Database(dbPath, { readonly: true });

  const headers = db
    .prepare(
      `SELECT composerId, value, lastUpdatedAt FROM composerHeaders
       WHERE IFNULL(isSubagent,0)=0 ORDER BY lastUpdatedAt DESC`,
    )
    .all();

  const meta = new Map();
  headers.forEach((h, i) => {
    let header = {};
    try {
      header = JSON.parse(h.value);
    } catch {}
    meta.set(h.composerId, {
      sessionIndex: i + 1,
      title: header.name ?? "(untitled)",
      workspace:
        header.workspaceIdentifier?.uri?.fsPath ??
        header.workspaceIdentifier?.uri?.path ??
        header.workspaceIdentifier?.id ??
        "unknown",
      updatedAt: new Date(h.lastUpdatedAt).toISOString().slice(0, 10),
    });
  });

  // One pass: all bubbles
  const bubbles = db
    .prepare(
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid ASC`,
    )
    .all();

  const threads = new Map();
  for (const row of bubbles) {
    const sessionId = row.key.split(":")[1];
    if (!meta.has(sessionId)) continue;
    try {
      const b = JSON.parse(row.value);
      const raw = b.text ?? "";
      const text = strip(raw);
      if (!text || isSystemNoise(text)) continue;
      if (!threads.has(sessionId)) threads.set(sessionId, []);
      threads.get(sessionId).push({
        role: b.type === 2 ? "assistant" : "user",
        text,
        raw,
      });
    } catch {}
  }
  db.close();

  const sessions = [];
  const allUserMsgs = [];

  for (const [sessionId, thread] of threads) {
    const m = meta.get(sessionId);
    const userMsgs = [];
    let userIdx = 0;
    for (let i = 0; i < thread.length; i++) {
      if (thread[i].role !== "user") continue;
      userIdx++;
      let prevAsst = null;
      for (let j = i - 1; j >= 0; j--) {
        if (thread[j].role === "assistant") {
          prevAsst = thread[j].text;
          break;
        }
      }
      const afterClaimedDone = priorClaimedDone(prevAsst);
      const scores = analyze(thread[i].text, {
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
        sessionIndex: m.sessionIndex,
        title: m.title,
        updatedAt: m.updatedAt,
        workspace: m.workspace,
        fullText: thread[i].text,
        priorAssistantTail: prevAsst ? prevAsst.slice(-400) : null,
      });
    }
    if (!userMsgs.length) continue;

    const avg = (k) => userMsgs.reduce((s, x) => s + x[k], 0) / userMsgs.length;
    const peakFrustration = userMsgs.reduce((a, b) => (b.frustration > a.frustration ? b : a));
    const half = Math.ceil(userMsgs.length / 2);
    const avgFirst =
      userMsgs.slice(0, half).reduce((s, x) => s + x.frustration, 0) / half;
    const avgSecond =
      userMsgs.slice(half).reduce((s, x) => s + x.frustration, 0) / (userMsgs.length - half || 1);

    const labelCounts = {};
    for (const u of userMsgs) labelCounts[u.label] = (labelCounts[u.label] ?? 0) + 1;

    sessions.push({
      ...m,
      sessionId,
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

  const labelDist = {};
  for (const u of allUserMsgs) labelDist[u.label] = (labelDist[u.label] ?? 0) + 1;

  const frustratedMsgs = allUserMsgs
    .filter((u) => u.frustration >= 0.55)
    .sort((a, b) => b.frustration - a.frustration);

  const afterDoneFails = allUserMsgs
    .filter((u) => u.afterClaimedDone && u.frustration >= 0.45)
    .sort((a, b) => b.frustration - a.frustration);

  const hardest = sessions
    .filter((s) => s.avgFrustration >= 0.32 || s.peakFrustration.score >= 0.65)
    .sort((a, b) => b.avgFrustration - a.avgFrustration);

  const qualifyingForClassification = allUserMsgs
    .filter((u) => u.frustration >= 0.45)
    .sort((a, b) => b.frustration - a.frustration);
  const classificationSource =
    qualifyingForClassification.length >= 100
      ? qualifyingForClassification.slice(0, 100)
      : [...allUserMsgs].sort((a, b) => b.frustration - a.frustration).slice(0, 100);
  const forClassification = classificationSource.map((u) => ({
    sessionIndex: u.sessionIndex,
    title: u.title,
    updatedAt: u.updatedAt,
    msgIndex: u.msgIndex,
    text: u.fullText,
    scores: {
      frustration: u.frustration,
      confusion: u.confusion,
      satisfaction: u.satisfaction,
      valence: u.valence,
      label: u.label,
    },
    afterClaimedDone: u.afterClaimedDone,
    priorAssistantTail: u.priorAssistantTail,
    workspace: u.workspace,
  }));

  const byMonth = {};
  for (const s of sessions) {
    const month = s.updatedAt.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { n: 0, fr: 0, val: 0, conf: 0 };
    byMonth[month].n++;
    byMonth[month].fr += s.avgFrustration;
    byMonth[month].val += s.avgValence;
    byMonth[month].conf += s.avgConfusion;
  }
  for (const k of Object.keys(byMonth)) {
    const b = byMonth[k];
    b.avgFrustration = +(b.fr / b.n).toFixed(3);
    b.avgValence = +(b.val / b.n).toFixed(3);
    b.avgConfusion = +(b.conf / b.n).toFixed(3);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method:
      "Multi-axis scoring: valence, frustration, confusion, satisfaction. Context-aware (reacts after assistant 'done' claims, thread depth, terse follow-ups).",
    totals: {
      sessions: sessions.length,
      userMessages: allUserMsgs.length,
      labels: labelDist,
    },
    global: {
      valence: +(allUserMsgs.reduce((s, u) => s + u.valence, 0) / allUserMsgs.length).toFixed(3),
      frustration: +(allUserMsgs.reduce((s, u) => s + u.frustration, 0) / allUserMsgs.length).toFixed(3),
      confusion: +(allUserMsgs.reduce((s, u) => s + u.confusion, 0) / allUserMsgs.length).toFixed(3),
      satisfaction: +(allUserMsgs.reduce((s, u) => s + u.satisfaction, 0) / allUserMsgs.length).toFixed(3),
    },
    monthlyTrend: byMonth,
    topFrustratedMessages: frustratedMsgs.slice(0, 40),
    afterAssistantClaimedDone: afterDoneFails.slice(0, 25),
    hardestSessions: hardest.slice(0, 20),
    escalatingSessions: sessions.filter((s) => s.escalating).sort((a, b) => b.avgFrustration - a.avgFrustration).slice(0, 15),
    forClassification,
  };

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  writeFileSync(
    CLASSIFY_OUT,
    JSON.stringify({ generatedAt: report.generatedAt, messages: forClassification }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        out: OUT,
        classifyOut: CLASSIFY_OUT,
        forClassificationCount: forClassification.length,
        userMessages: report.totals.userMessages,
        global: report.global,
        labels: report.totals.labels,
        monthlyTrend: report.monthlyTrend,
        topFrustrated: report.topFrustratedMessages.slice(0, 12).map((m) => ({
          f: m.frustration,
          v: m.valence,
          title: m.title,
          quote: m.text,
        })),
        afterDoneFails: report.afterAssistantClaimedDone.slice(0, 8).map((m) => ({
          f: m.frustration,
          title: m.title,
          quote: m.text,
        })),
        hardestSessions: report.hardestSessions.slice(0, 8).map((s) => ({
          title: s.title,
          avgFr: s.avgFrustration,
          peak: s.peakFrustration.text,
        })),
      },
      null,
      2,
    ),
  );
}

main();
