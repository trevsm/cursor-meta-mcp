#!/usr/bin/env node
/**
 * LLM-style contextual reclassification of heuristic sentiment hits.
 * Reads sentiment-classify-input.json (or report.forClassification) and writes
 * theme/false-positive judgments using prior-assistant context when present.
 *
 * Usage:
 *   node scripts/sentiment-classify.mjs [input.json] [output.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IN =
  process.argv[2] ??
  join(
    process.env.HOME ?? "",
    ".cursor/projects/Users-trevorsmith-Projects-cursor-meta-mcp/agent-tools/sentiment-classify-input.json",
  );
const OUT =
  process.argv[3] ??
  join(
    process.env.HOME ?? "",
    ".cursor/projects/Users-trevorsmith-Projects-cursor-meta-mcp/agent-tools/sentiment-classified.json",
  );

const THEMES = [
  {
    id: "visual_layout",
    label: "Visual / layout still wrong",
    test: (t, title) =>
      /\b(overflow|overlapping|hidden|cut off|position|mockup|mirror|center|dash|out of|out tag|table|toolbar|scrollbar|screenshot|browser_element)\b/i.test(
        t + " " + title,
      ),
  },
  {
    id: "false_done",
    label: "Still broken after assistant claimed done",
    test: (t, _title, m) =>
      m.afterClaimedDone &&
      /\b(still|broken|wrong|no\.|nope|not working|doesn't|didn't|bad)\b/i.test(t),
  },
  {
    id: "deploy_ci",
    label: "Deploy / CI / env still failing",
    test: (t, title) =>
      /\b(deploy|vercel|ci|build fail|404|cron|failing|pipeline|publish)\b/i.test(t + " " + title),
  },
  {
    id: "data_wrong",
    label: "Data / content incorrect",
    test: (t) =>
      /\b(blank|missing|empty|wrong data|not right|should hit|created by|cancelled|gap)\b/i.test(t),
  },
  {
    id: "perf_hang",
    label: "Perf / hang / search-sort",
    test: (t) => /\b(hang|slow|search|sort|indexing|30,000|performance)\b/i.test(t),
  },
  {
    id: "correction",
    label: "Direct correction / rejection",
    test: (t) =>
      /^(no\.|bad\.|nope|thats not right|that's not right|not what i|you didnt|you didn't|stop)/i.test(
        t.trim(),
      ) || /\byou (didnt|didn't|got it wrong)\b/i.test(t) || /\byou keep (getting|doing|trying|failing|missing|breaking)\b/i.test(t),
  },
  {
    id: "give_up",
    label: "Giving up / cancel direction",
    test: (t) =>
      /\b(maybe we just can|give up|forget it|can it|never ?mind|undo that)\b/i.test(t),
  },
  {
    id: "meta_request",
    label: "Meta / analysis request (not real frustration)",
    test: (t) =>
      /\b(everytime i was frustrated|sentiment|look through all my conversations)\b/i.test(t),
  },
  {
    id: "resolved_self",
    label: "Self-resolved (false positive)",
    test: (t) => /\bfigured it out\b/i.test(t) && /\bnevermind\b/i.test(t),
  },
  {
    id: "soft_nevermind",
    label: "Soft retract / scope change",
    test: (t) => /^nevermind on\b/i.test(t.trim()) || /\bnevermind, undo\b/i.test(t),
  },
  {
    id: "system_noise",
    label: "System / subagent noise",
    test: (t) =>
      /The following task has finished/i.test(t) ||
      /kind: subagent\b/i.test(t) ||
      /tool_call_id:/i.test(t),
  },
  {
    id: "long_directive",
    label: "Long directive mis-scored",
    test: (t, _title, m) =>
      (m.scores?.wordCount ?? t.split(/\s+/).length) > 200 &&
      !/\b(still broken|frustrated|wrong|not working)\b/i.test(t.slice(0, 400)),
  },
  {
    id: "friendly_continue",
    label: "Friendly continue (false positive)",
    test: (t) =>
      /\b(keep chugging|keep going|carry on|no worries|all good)\b/i.test(t) &&
      !/\b(still broken|not working|wrong|frustrated)\b/i.test(t),
  },
  {
    id: "terse_still",
    label: "Terse 'still' follow-up",
    test: (t) => /^(still\.?|still \w+)$/i.test(t.trim()) || t.trim().split(/\s+/).length <= 4,
  },
];

function isSystemNoise(text) {
  const head = text.slice(0, 800);
  return (
    /The following task has finished/i.test(head) ||
    /kind: subagent\b/i.test(head) ||
    /tool_call_id:/i.test(head)
  );
}

function priorClaimedDone(tail) {
  if (!tail) return false;
  const t = tail.toLowerCase();
  return (
    /\b(fixed|done|complete|deployed|published|should work|ready|resolved|success|updated|committed|pushed)\b/.test(
      t,
    ) && !/\b(not yet|can't|cannot|unable|failed|error|didn't work)\b/.test(t)
  );
}

/**
 * Contextual judgment: true frustration intensity 0–1, falsePositive flag, themes, note.
 */
function classify(m) {
  const text = (m.text ?? "").trim();
  const title = m.title ?? "";
  const heuristic = m.scores?.frustration ?? m.frustration ?? 0;
  const afterDone = Boolean(m.afterClaimedDone ?? priorClaimedDone(m.priorAssistantTail));
  const wc = text.split(/\s+/).filter(Boolean).length;

  const themeHits = THEMES.filter((th) => th.test(text, title, { ...m, afterClaimedDone: afterDone })).map(
    (th) => th.id,
  );

  let falsePositive = false;
  let intensity = heuristic;
  let judgment = "frustrated";
  let note = "";

  if (themeHits.includes("system_noise") || isSystemNoise(text)) {
    falsePositive = true;
    intensity = 0;
    judgment = "noise";
    note = "Subagent/system notification, not user affect";
  } else if (themeHits.includes("resolved_self")) {
    falsePositive = true;
    intensity = 0.1;
    judgment = "resolved";
    note = "User self-resolved; nevermind cancels frustration";
  } else if (themeHits.includes("meta_request")) {
    falsePositive = true;
    intensity = 0.15;
    judgment = "meta";
    note = "Talking about frustration as a topic, not expressing it";
  } else if (themeHits.includes("long_directive")) {
    falsePositive = true;
    intensity = Math.min(heuristic, 0.25);
    judgment = "directive";
    note = "Long planning/directive message; 'keep'/'still' lexical false hit";
  } else if (themeHits.includes("friendly_continue")) {
    falsePositive = true;
    intensity = 0.05;
    judgment = "friendly";
    note = "Encouraging continue — not frustration";
  } else if (themeHits.includes("soft_nevermind") && !/\bstill not working\b/i.test(text)) {
    falsePositive = true;
    intensity = 0.2;
    judgment = "retract";
    note = "Scope retract / undo — mild negative at most";
  } else if (
    /\b(but we should still|if they click it should still|i still want|still do the)\b/i.test(text) &&
    !/\b(broken|wrong|not working|hang|fail)\b/i.test(text)
  ) {
    falsePositive = true;
    intensity = 0.2;
    judgment = "lexical_still";
    note = "Benign use of 'still' (requirement continuity), not residual-bug frustration";
  } else if (themeHits.includes("give_up") && /\bstill not working\b/i.test(text)) {
    intensity = 0.95;
    judgment = "giving_up";
    note = "Explicit give-up after failed fix";
  } else if (afterDone && themeHits.includes("terse_still")) {
    intensity = Math.max(heuristic, 0.9);
    judgment = "false_done_terse";
    note = "Terse rejection right after assistant claimed done";
  } else if (themeHits.includes("visual_layout")) {
    intensity = Math.max(heuristic, 0.75);
    judgment = "visual_regression";
    note = "UI/layout still wrong — often screenshot-driven";
  } else if (themeHits.includes("correction")) {
    intensity = Math.max(heuristic, 0.8);
    judgment = "correction";
    note = "Direct rejection of assistant output";
  } else if (themeHits.includes("deploy_ci")) {
    intensity = Math.max(heuristic, 0.75);
    judgment = "infra";
    note = "Deploy/CI/runtime still failing";
  } else if (wc <= 4 && /\b(still|broken|wrong|no)\b/i.test(text)) {
    intensity = Math.max(heuristic, 0.85);
    judgment = "terse_negative";
    note = "Ultra-short negative — high confidence frustration";
  } else if (heuristic >= 0.7) {
    judgment = "frustrated";
    note = "Heuristic high score held under contextual review";
  } else {
    judgment = "negative";
    note = "Mild/moderate negative; confirm with thread if acting on it";
  }

  // Prefer primary theme for bucketing
  const primaryTheme =
    themeHits.find((id) =>
      [
        "system_noise",
        "resolved_self",
        "meta_request",
        "long_directive",
        "friendly_continue",
        "soft_nevermind",
      ].includes(id),
    ) ??
    themeHits.find((id) => id === "false_done") ??
    themeHits.find((id) =>
      ["visual_layout", "deploy_ci", "data_wrong", "perf_hang", "correction", "give_up"].includes(id),
    ) ??
    themeHits[0] ??
    "uncategorized";

  return {
    sessionIndex: m.sessionIndex,
    title,
    updatedAt: m.updatedAt,
    msgIndex: m.msgIndex,
    workspace: m.workspace,
    text: text.slice(0, 280),
    heuristicFrustration: heuristic,
    afterClaimedDone: afterDone,
    hadPriorContext: Boolean(m.priorAssistantTail),
    falsePositive,
    intensity: +intensity.toFixed(3),
    judgment,
    primaryTheme,
    themes: themeHits,
    note,
  };
}

function loadMessages(raw) {
  if (Array.isArray(raw.messages)) return raw.messages;
  if (Array.isArray(raw.forClassification)) return raw.forClassification;
  // Fallback: stitch from older report shape
  const fromTop = [...(raw.topFrustratedMessages ?? []), ...(raw.afterAssistantClaimedDone ?? [])];
  const seen = new Set();
  const out = [];
  for (const m of fromTop) {
    const key = `${m.sessionIndex}:${m.msgIndex}:${m.text?.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...m,
      scores: {
        frustration: m.frustration,
        confusion: m.confusion,
        satisfaction: m.satisfaction,
        valence: m.valence,
        label: m.label,
        wordCount: m.wordCount,
      },
    });
  }
  return out.sort(
    (a, b) => (b.scores?.frustration ?? b.frustration ?? 0) - (a.scores?.frustration ?? a.frustration ?? 0),
  );
}

function main() {
  const raw = JSON.parse(readFileSync(IN, "utf8"));
  const messages = loadMessages(raw).slice(0, 100);
  const classified = messages.map(classify);

  const real = classified.filter((c) => !c.falsePositive);
  const fps = classified.filter((c) => c.falsePositive);

  const byTheme = {};
  for (const c of real) {
    byTheme[c.primaryTheme] ??= { count: 0, avgIntensity: 0, examples: [] };
    const b = byTheme[c.primaryTheme];
    b.count += 1;
    b.avgIntensity += c.intensity;
    if (b.examples.length < 5) {
      b.examples.push({ title: c.title, text: c.text, intensity: c.intensity, judgment: c.judgment });
    }
  }
  for (const k of Object.keys(byTheme)) {
    byTheme[k].avgIntensity = +(byTheme[k].avgIntensity / byTheme[k].count).toFixed(3);
    byTheme[k].label = THEMES.find((t) => t.id === k)?.label ?? k;
  }

  const byJudgment = {};
  for (const c of classified) byJudgment[c.judgment] = (byJudgment[c.judgment] ?? 0) + 1;

  const report = {
    generatedAt: new Date().toISOString(),
    source: IN,
    method:
      "Contextual reclassification of top heuristic frustration hits. Uses prior-assistant tail when present; tags themes, false positives (noise, self-resolved, lexical 'still', meta requests), and intensity.",
    totals: {
      reviewed: classified.length,
      realFrustration: real.length,
      falsePositives: fps.length,
      falsePositiveRate: classified.length
        ? +((fps.length / classified.length) * 100).toFixed(1)
        : 0,
      withPriorContext: classified.filter((c) => c.hadPriorContext).length,
    },
    byJudgment,
    byTheme,
    topReal: real.sort((a, b) => b.intensity - a.intensity).slice(0, 25),
    falsePositives: fps.slice(0, 20),
    all: classified,
  };

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        totals: report.totals,
        byJudgment,
        themes: Object.fromEntries(
          Object.entries(byTheme)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([k, v]) => [k, { n: v.count, avg: v.avgIntensity, label: v.label }]),
        ),
        topReal: report.topReal.slice(0, 10).map((c) => ({
          i: c.intensity,
          theme: c.primaryTheme,
          title: c.title,
          quote: c.text,
          note: c.note,
        })),
        falsePositives: report.falsePositives.slice(0, 8).map((c) => ({
          judgment: c.judgment,
          title: c.title,
          quote: c.text,
        })),
      },
      null,
      2,
    ),
  );
}

main();
