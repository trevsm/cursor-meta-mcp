/** PROTOTYPE — sample atlas index (LLM segmentation simulated by hand) */
export const THEMES = [
  {
    id: "financial-audit",
    label: "Financial audit & MyPlace data",
    color: "#6366f1",
    description: "Populate endpoint, July preload, site eval numbers",
    summary: "Debugging the financial-audit populate endpoint — stale deploys, wiring allPropertiesTopDown, backfilling July data across 66 properties, and toggling the debug endpoint.",
  },
  {
    id: "formula-scheduling",
    label: "Relate formula scheduling",
    color: "#f59e0b",
    description: "snapshot vs draft, scheduleMinutes harness, Yardi enable",
    summary: "Proving scheduled formulas actually run: empty snapshot/ bug, runImmediate is a dead end, harness on Store, then enabling Yardi on a 5-minute test schedule.",
  },
  {
    id: "incident-reports",
    label: "Incident report automation",
    color: "#10b981",
    description: "Weekly email formula, bluestep wiring",
    summary: "Building and wiring the weekly incident report email formula — recipients, schedule, and bluestep deploy.",
  },
  {
    id: "cursor-tooling",
    label: "Cursor meta & chat tooling",
    color: "#ec4899",
    description: "MCP, chat search, conversation atlas",
    summary: "cursor-meta-mcp work — cross-chat thinking search, conversation atlas wayfinding, sentiment over chat history.",
  },
  {
    id: "mac-apps",
    label: "macOS apps & setup",
    color: "#8b5cf6",
    description: "HostBlock installs, skills",
    summary: "Local macOS setup — duplicate HostBlock.app from DMG vs source build, cleaning up the extra copy.",
  },
];

export const SESSIONS = [
  {
    id: "5685d379-4d1c-4cf8-ba5a-464f67032595",
    title: "MyPlace audit cursor convo",
    workspace: "faciliq-relate-apps",
    updatedAt: "2026-08-05T22:23:08.587Z",
    themeIds: ["financial-audit"],
  },
  {
    id: "ce27e591-0697-4030-9b3a-fb217a5ecfcf",
    title: "Missing items review",
    workspace: "faciliq-relate-apps",
    updatedAt: "2026-08-05T23:18:00.451Z",
    themeIds: ["formula-scheduling"],
  },
  {
    id: "b68a73ef-4660-4471-833a-d5b1685a814b",
    title: "Yardi Formula (Debugging)",
    workspace: "faciliq-relate-apps",
    updatedAt: "2026-08-05T21:56:46.796Z",
    themeIds: ["formula-scheduling", "financial-audit"],
  },
  {
    id: "49fc86e6-067f-46ef-997f-f005b2e1e480",
    title: "Weekly incident report automation",
    workspace: "faciliq-relate-apps",
    updatedAt: "2026-08-05T22:11:22.802Z",
    themeIds: ["incident-reports"],
  },
  {
    id: "4b267d26-804f-49be-b134-e3de787a66d5",
    title: "Visual conversation navigation",
    workspace: "cursor-meta-mcp",
    updatedAt: "2026-08-06T04:12:32.765Z",
    themeIds: ["cursor-tooling"],
    startsInActive: true,
    liveSummary: "Wayfinder map + prototype: theme columns, active inbox, spine+overlay model for browsing chats.",
  },
  {
    id: "94a35aca-02f3-469c-ba37-c52486a8be94",
    title: "Basic artificial consciousness design",
    workspace: "micro-consciousness",
    updatedAt: "2026-08-06T04:10:43.817Z",
    themeIds: [],
    startsInActive: true,
    liveSummary: "Wayfinding ethical bounds and code-testable proxies for minimal consciousness experiments.",
  },
  {
    id: "52aae0b6-82f0-4040-9869-e494925fc16a",
    title: "Frustration in cursor conversations",
    workspace: "cursor-meta-mcp-orchestration",
    updatedAt: "2026-08-06T03:42:35.282Z",
    themeIds: ["cursor-tooling"],
    startsInActive: true,
    liveSummary: "Sentiment analysis over thinking.text — surfacing frustration patterns across chat history.",
  },
  {
    id: "7ee00584-dcd0-41de-a769-6af2043e42ae",
    title: "Google Analytics and Sentry injection",
    workspace: "faciliq-relate-apps",
    updatedAt: "2026-08-05T20:25:19.113Z",
    themeIds: ["cursor-tooling"],
  },
  {
    id: "2400338e-01bd-4539-8a8b-a10fb9f20aff",
    title: "Host block applications inquiry",
    workspace: "empty-window",
    updatedAt: "2026-08-05T22:50:02.111Z",
    themeIds: ["mac-apps"],
  },
];

/** turnIndex is 1-based user turn; preview is slice text */
export const SEGMENTS = [
  {
    id: "seg-myplace-populate",
    sessionId: "5685d379-4d1c-4cf8-ba5a-464f67032595",
    themeId: "financial-audit",
    turnStart: 1,
    turnEnd: 4,
    preview: "Stale .build deploy — populate returned NO CHANGE, June numbers in site eval",
  },
  {
    id: "seg-myplace-wire",
    sessionId: "5685d379-4d1c-4cf8-ba5a-464f67032595",
    themeId: "financial-audit",
    turnStart: 5,
    turnEnd: 7,
    preview: "allPropertiesTopDown not defined → .require() fix → still failing",
  },
  {
    id: "seg-myplace-mcp",
    sessionId: "5685d379-4d1c-4cf8-ba5a-464f67032595",
    themeId: "financial-audit",
    turnStart: 8,
    turnEnd: 9,
    preview: "Query never wired on server — MCP wiring + MEFR attach",
  },
  {
    id: "seg-myplace-success",
    sessionId: "5685d379-4d1c-4cf8-ba5a-464f67032595",
    themeId: "financial-audit",
    turnStart: 10,
    turnEnd: 12,
    preview: "66/68 properties populated; disable endpoint toggle",
  },
  {
    id: "seg-harness-discovery",
    sessionId: "ce27e591-0697-4030-9b3a-fb217a5ecfcf",
    themeId: "formula-scheduling",
    turnStart: 1,
    turnEnd: 3,
    preview: "runImmediate never works; scheduleMinutes:5 is the proven path",
  },
  {
    id: "seg-harness-snapshot",
    sessionId: "ce27e591-0697-4030-9b3a-fb217a5ecfcf",
    themeId: "formula-scheduling",
    turnStart: 4,
    turnEnd: 6,
    preview: "Empty snapshot/ — MCP writes draft only; scheduler runs nothing",
  },
  {
    id: "seg-harness-yardi",
    sessionId: "ce27e591-0697-4030-9b3a-fb217a5ecfcf",
    themeId: "formula-scheduling",
    turnStart: 7,
    turnEnd: 8,
    preview: "Enable Yardi on 5-min test schedule, no prod emails",
  },
  {
    id: "seg-yardi-debug",
    sessionId: "b68a73ef-4660-4471-833a-d5b1685a814b",
    themeId: "formula-scheduling",
    turnStart: 1,
    turnEnd: 4,
    preview: "Imports.ts deploy, bluestep.json wiring, formula disabled state",
  },
  {
    id: "seg-incident-build",
    sessionId: "49fc86e6-067f-46ef-997f-f005b2e1e480",
    themeId: "incident-reports",
    turnStart: 1,
    turnEnd: 5,
    preview: "incidentReportWeeklyEmail.ts, schedule, email recipients",
  },
  {
    id: "seg-atlas-wayfinder",
    sessionId: "4b267d26-804f-49be-b134-e3de787a66d5",
    themeId: "cursor-tooling",
    turnStart: 1,
    turnEnd: 6,
    preview: "Wayfinder map, spine+overlay model, LLM segmentation decision",
  },
  {
    id: "seg-frustration-sentiment",
    sessionId: "52aae0b6-82f0-4040-9869-e494925fc16a",
    themeId: "cursor-tooling",
    turnStart: 1,
    turnEnd: 4,
    preview: "Sentiment analysis on thinking.text — frustration patterns in chats",
  },
  {
    id: "seg-chat-search",
    sessionId: "7ee00584-dcd0-41de-a769-6af2043e42ae",
    themeId: "cursor-tooling",
    turnStart: 1,
    turnEnd: 3,
    preview: "chat-search.ts thinking.text full-text scan across bubbles",
  },
  {
    id: "seg-hostblock",
    sessionId: "2400338e-01bd-4539-8a8b-a10fb9f20aff",
    themeId: "mac-apps",
    turnStart: 1,
    turnEnd: 2,
    preview: "Two HostBlock.app copies — DMG vs source build; delete dist copy",
  },
];

/** Spine turns for conversation drill-down (MyPlace audit — richest example) */
export const SPINE = {
  "5685d379-4d1c-4cf8-ba5a-464f67032595": {
    turns: [
      { n: 1, role: "assistant", preview: "Populate ran but server logged ==NO CHANGE", segmentId: "seg-myplace-populate" },
      { n: 2, role: "assistant", preview: "Stale .build/scripts/app.js — populate never compiled", segmentId: "seg-myplace-populate" },
      { n: 3, role: "assistant", preview: "Fix deployed — please run populate again", segmentId: "seg-myplace-populate" },
      { n: 4, role: "user", preview: "populate JSON: allPropertiesTopDown is not defined", segmentId: "seg-myplace-wire", branch: null },
      { n: 5, role: "assistant", preview: "Missing .require('allPropertiesTopDown') — fixing", segmentId: "seg-myplace-wire" },
      { n: 6, role: "user", preview: "same error again (retry)", segmentId: "seg-myplace-wire", branch: "edit-resend" },
      { n: 7, role: "assistant", preview: "Endpoint had no query wired on server — MCP fix", segmentId: "seg-myplace-mcp" },
      { n: 8, role: "user", preview: "processedRows: 1 — Apache Junction success", segmentId: "seg-myplace-success" },
      { n: 9, role: "user", preview: "full populate 66/68 properties", segmentId: "seg-myplace-success" },
      { n: 10, role: "user", preview: "toggle disable the endpoint", segmentId: "seg-myplace-success" },
      { n: 11, role: "user", preview: "it ran (despite disabled flag)", segmentId: "seg-myplace-success" },
    ],
    branches: [
      {
        id: "br-myplace-6",
        parentTurn: 6,
        label: "edited resend",
        orphanPreview: "just re-ran populate without waiting for deploy",
        status: "pruned",
      },
    ],
  },
};

/**
 * Nested branch tree — edit/resend forks with sub-branches (prototype sample).
 * `next` = canonical path; `forks` = pruned alternatives at this point.
 */
export const CONVERSATION_TREES = {
  "5685d379-4d1c-4cf8-ba5a-464f67032595": {
    id: "t1",
    role: "assistant",
    preview: "Populate ran but server logged ==NO CHANGE",
    forks: [],
    next: {
      id: "t2",
      role: "assistant",
      preview: "Stale .build/scripts/app.js — populate never compiled",
      forks: [],
      next: {
        id: "t3",
        role: "assistant",
        preview: "Fix deployed — please run populate again",
        forks: [],
        next: {
          id: "u4",
          role: "user",
          preview: "populate JSON: allPropertiesTopDown is not defined",
          forks: [
            {
              forkLabel: "edit v1 · shorter ask",
              root: {
                id: "u4-f1",
                role: "user",
                preview: "populate still broken?",
                forks: [],
                next: {
                  id: "a4-f1",
                  role: "assistant",
                  preview: "Checking whether deploy finished…",
                  forks: [],
                  next: null,
                },
              },
            },
            {
              forkLabel: "edit v2 · added logs",
              root: {
                id: "u4-f2",
                role: "user",
                preview: "populate failed — here's the server log snippet",
                forks: [],
                next: {
                  id: "a4-f2",
                  role: "assistant",
                  preview: "Log shows old debug handler — redeploying",
                  forks: [
                    {
                      forkLabel: "aborted regen",
                      root: {
                        id: "a4-f2-abort",
                        role: "assistant",
                        preview: "Verifying with authenticated request…",
                        forks: [],
                        next: null,
                      },
                    },
                  ],
                  next: null,
                },
              },
            },
            {
              forkLabel: "edit v3 · wrong locationId",
              root: {
                id: "u4-f3",
                role: "user",
                preview: "try locationId=999999 instead",
                forks: [],
                next: {
                  id: "a4-f3",
                  role: "assistant",
                  preview: "That ID doesn't exist in MyPlace — use 203130",
                  forks: [],
                  next: null,
                },
              },
            },
          ],
          next: {
            id: "a5",
            role: "assistant",
            preview: "Missing .require('allPropertiesTopDown') — fixing",
            forks: [],
            next: {
              id: "u6",
              role: "user",
              preview: "same error again (retry)",
              forks: [
                {
                  forkLabel: "resend without waiting",
                  root: {
                    id: "u6-f1",
                    role: "user",
                    preview: "just re-ran populate without waiting for deploy",
                    forks: [],
                    next: {
                      id: "a6-f1",
                      role: "assistant",
                      preview: "Still stale JS on server — same error expected",
                      forks: [],
                      next: null,
                    },
                  },
                },
                {
                  forkLabel: "edit · ask about require()",
                  root: {
                    id: "u6-f2",
                    role: "user",
                    preview: "is .require() even the right API for query globals?",
                    forks: [
                      {
                        forkLabel: "aborted mid-thought",
                        root: {
                          id: "a6-f2-partial",
                          role: "assistant",
                          preview: "Looking at other endpoints that use query groups…",
                          forks: [],
                          next: null,
                        },
                      },
                    ],
                    next: {
                      id: "a6-f2",
                      role: "assistant",
                      preview: "Yes — needs group name: .require('allPropertiesTopDown')",
                      forks: [],
                      next: null,
                    },
                  },
                },
              ],
              next: {
                id: "a7",
                role: "assistant",
                preview: "Endpoint had no query wired on server — MCP fix",
                forks: [],
                next: {
                  id: "u8",
                  role: "user",
                  preview: "processedRows: 1 — Apache Junction success",
                  forks: [],
                  next: {
                    id: "u9",
                    role: "user",
                    preview: "full populate 66/68 properties",
                    forks: [],
                    next: {
                      id: "u10",
                      role: "user",
                      preview: "toggle disable the endpoint",
                      forks: [],
                      next: {
                        id: "u11",
                        role: "user",
                        preview: "it ran (despite disabled flag)",
                        forks: [],
                        next: null,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function conversationTree(sessionId) {
  return CONVERSATION_TREES[sessionId] || null;
}

/** Readable excerpts per slice (prototype stand-in for LLM + transcript fetch) */
export const SLICE_CONTENT = {
  "seg-harness-discovery": [
    { role: "assistant", text: "runImmediate has never been shown to work — including right now." },
    { role: "assistant", text: "The proven substitute is scheduleMinutes: 5: set it, wait up to five minutes, read your logs." },
  ],
  "seg-harness-snapshot": [
    { role: "assistant", text: "MCP write_script_draft writes only to draft/ — snapshot/scripts/app.ts was 0 bytes." },
    { role: "assistant", text: "The scheduler dutifully ran empty code. lastRunTime ticked, nothing happened." },
  ],
  "seg-harness-yardi": [
    { role: "user", text: "so what do we need to do to get the yardi report to run? no prod emails" },
    { role: "assistant", text: "Enabling Yardi on 5-min test schedule, capturing baseline notification count…" },
  ],
  "seg-yardi-debug": [
    { role: "assistant", text: "Edited imports.ts, bluestep.json — formula currently disabled on server." },
  ],
  "seg-incident-build": [
    { role: "assistant", text: "Built incidentReportWeeklyEmail.ts with schedule + recipient gating." },
  ],
  "seg-atlas-wayfinder": [
    { role: "user", text: "I want a visual representation to traverse my cursor conversations…" },
    { role: "assistant", text: "Theme-first home; spine+overlay model; segments as grouping unit." },
  ],
  "seg-frustration-sentiment": [
    { role: "user", text: "Can we analyze frustration patterns across my chats?" },
    { role: "assistant", text: "Scanning thinking.text in state.vscdb bubbles for sentiment signals." },
  ],
  "seg-chat-search": [
    { role: "assistant", text: "Added meta_search_thinking — fast cross-chat search over thinking.text + user prompts." },
  ],
  "seg-hostblock": [
    { role: "user", text: "Why do I have two host block applications?" },
    { role: "assistant", text: "DMG install + source build both copied to /Applications. Delete dist copy." },
  ],
};

export function turnsForSegment(seg) {
  const spine = SPINE[seg.sessionId];
  if (spine) {
    return spine.turns.filter((t) => t.n >= seg.turnStart && t.n <= seg.turnEnd);
  }
  return (SLICE_CONTENT[seg.id] || []).map((t, i) => ({
    n: seg.turnStart + i,
    role: t.role,
    preview: t.text,
  }));
}

export const SAMPLE_DATA = {
  THEMES,
  SESSIONS,
  SEGMENTS,
  SPINE,
};

export function sessionById(id) {
  return SESSIONS.find((s) => s.id === id);
}

export function segmentsForSession(sessionId) {
  return SEGMENTS.filter((s) => s.sessionId === sessionId);
}

export function segmentsForTheme(themeId) {
  return SEGMENTS.filter((s) => s.themeId === themeId);
}

/** Sessions that start in the active inbox vs pre-filed in theme columns */
export function initialActiveIds() {
  return new Set(SESSIONS.filter((s) => s.startsInActive).map((s) => s.id));
}

/** Sample pinned chats for offline prototype */
export function initialPinnedIds() {
  return [
    "4b267d26-804f-49be-b134-e3de787a66d5",
    "5685d379-4d1c-4cf8-ba5a-464f67032595",
  ];
}

export function initialFiledMap() {
  const filed = {};
  for (const s of SESSIONS) {
    if (!s.startsInActive && s.themeIds?.length) {
      filed[s.id] = [...s.themeIds];
    }
  }
  return filed;
}

export function initialAnalyzedIds() {
  return new Set(
    SESSIONS.filter((s) => !s.startsInActive && segmentsForSession(s.id).length).map((s) => s.id),
  );
}

/** Example queries — click or type to demo cross-history search */
export const SEARCH_EXAMPLES = [
  "populate",
  "scheduleMinutes",
  "allPropertiesTopDown",
  "HostBlock",
  "conversation atlas",
  "frustration",
];

/** Flat index standing in for meta_search_thinking + FTS (prototype) */
export function buildSearchIndex() {
  const rows = [];
  for (const s of SESSIONS) {
    rows.push({
      id: `title-${s.id}`,
      sessionId: s.id,
      scope: "title",
      text: s.title,
      segmentId: null,
      turnStart: null,
      turnEnd: null,
    });
    if (s.liveSummary) {
      rows.push({
        id: `summary-${s.id}`,
        sessionId: s.id,
        scope: "summary",
        text: s.liveSummary,
        segmentId: null,
        turnStart: null,
        turnEnd: null,
      });
    }
  }
  for (const seg of SEGMENTS) {
    rows.push({
      id: `seg-${seg.id}`,
      sessionId: seg.sessionId,
      scope: "segment",
      text: `${seg.preview} ${sessionById(seg.sessionId)?.title || ""}`,
      segmentId: seg.id,
      turnStart: seg.turnStart,
      turnEnd: seg.turnEnd,
    });
    for (const t of turnsForSegment(seg)) {
      rows.push({
        id: `turn-${seg.id}-${t.n}`,
        sessionId: seg.sessionId,
        scope: t.role,
        text: t.preview,
        segmentId: seg.id,
        turnStart: t.n,
        turnEnd: t.n,
      });
    }
  }
  return rows;
}

const SEARCH_INDEX = buildSearchIndex();

export function searchHistory(query) {
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], elapsedMs: 0, scanned: 0 };
  const t0 = performance.now();
  const hits = [];
  for (const row of SEARCH_INDEX) {
    const hay = row.text.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 48);
    const end = Math.min(row.text.length, idx + q.length + 64);
    let snippet = row.text.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < row.text.length) snippet = snippet + "…";
    hits.push({
      ...row,
      snippet,
      matchAt: idx,
      rank: row.scope === "title" ? 3 : row.scope === "user" ? 2 : 1,
    });
  }
  hits.sort((a, b) => b.rank - a.rank || b.matchAt - a.matchAt);
  const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
  return {
    hits,
    elapsedMs,
    scanned: SEARCH_INDEX.length,
    sessions: new Set(hits.map((h) => h.sessionId)).size,
  };
}

export function highlightMatch(snippet, query) {
  const q = query.trim();
  if (!q) return htmlEsc(snippet);
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return htmlEsc(snippet).replace(re, "<mark>$1</mark>");
}

function htmlEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
