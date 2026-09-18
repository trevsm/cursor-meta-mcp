import { SAMPLE_DATA, initialActiveIds, initialPinnedIds, SEARCH_EXAMPLES, highlightMatch } from "./data.js";

const PINS_STORAGE_KEY = "atlas-pinned-sessions";
const LIVE_FETCH = { cache: "no-store" };

function liveFetch(url, init = {}) {
  return fetch(url, { ...LIVE_FETCH, ...init });
}

const state = {
  variant: new URLSearchParams(location.search).get("variant") || "A",
  view: "home",
  themeId: null,
  subthemeKey: null,
  sessionId: null,
  segmentId: null,
  highlightTurn: null,
  expandContext: false,
  cThemeId: null,
  loading: true,
  error: null,
  live: false,
  THEMES: [],
  SESSIONS: [],
  SEGMENTS: [],
  SPINE: {},
  spines: {},
  activeChats: [],
  pinnedSessionIds: [],
  pinnedChatItems: [],
  sessionActivity: null,
  _livePollTimer: null,
  _pendingScrollTurn: null,
  _scrollToBottomOnOpen: false,
  _searchHighlightTurn: null,
  _searchScrollLock: false,
};

const root = document.getElementById("app");
const crumb = document.getElementById("crumb");
const statusEl = document.getElementById("status");
const omniEl = document.getElementById("omni");
const searchTrigger = document.getElementById("search-trigger");

const omni = {
  open: false,
  closing: false,
  query: "",
  active: 0,
  hits: [],
  elapsedMs: 0,
  scanned: 0,
  searchTimer: null,
  searchGen: 0,
  searching: false,
  mounted: false,
};

async function loadAtlas() {
  state.loading = true;
  render();
  try {
    const [atlasRes, activeRes, pinsRes] = await Promise.all([
      liveFetch("/api/atlas"),
      liveFetch("/api/atlas/active"),
      liveFetch("/api/atlas/pins"),
    ]);
    if (!atlasRes.ok) throw new Error(`API ${atlasRes.status}`);
    const data = await atlasRes.json();
    state.THEMES = data.themes;
    state.SESSIONS = data.sessions;
    state.SEGMENTS = data.segments;
    state.cThemeId = data.themes[0]?.id ?? null;
    state.live = true;
    state.error = null;
    if (activeRes.ok) {
      const active = await activeRes.json();
      state.activeChats = active.items ?? [];
    } else {
      state.activeChats = [];
    }
    if (pinsRes.ok) {
      const pins = await pinsRes.json();
      state.pinnedSessionIds = pins.sessionIds ?? [];
      state.pinnedChatItems = pins.items ?? [];
      localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(state.pinnedSessionIds));
    } else {
      // Stale localStorage only has Atlas toggles — don't use it when the pins API is missing.
      state.pinnedSessionIds = [];
      state.pinnedChatItems = [];
      if (state.live) {
        state.error = state.error ?? `Pins API unavailable (${pinsRes.status}) — restart atlas server`;
      }
    }
  } catch (err) {
    state.THEMES = SAMPLE_DATA.THEMES;
    state.SESSIONS = SAMPLE_DATA.SESSIONS;
    state.SEGMENTS = SAMPLE_DATA.SEGMENTS;
    state.SPINE = SAMPLE_DATA.SPINE;
    state.cThemeId = SAMPLE_DATA.THEMES[0]?.id ?? null;
    state.live = false;
    state.error = String(err);
    const activeIds = initialActiveIds();
    state.activeChats = SAMPLE_DATA.SESSIONS.filter((s) => activeIds.has(s.id)).map((s) => ({
      sessionId: s.id,
      title: s.title,
      workspace: s.workspace,
      updatedAt: s.updatedAt,
      activityLevel: "recent",
      signals: [],
      liveSummary: s.liveSummary ?? segmentsForSession(s.id).at(-1)?.preview ?? "",
    }));
    state.pinnedSessionIds = [...initialPinnedIds()];
    state.pinnedChatItems = [];
  }
  state.loading = false;
  applyRoute(parseRouteFromLocation(), { replaceUrl: true });
  render();
}

function loadPinsFromStorage() {
  try {
    const raw = localStorage.getItem(PINS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? [...new Set(parsed.filter(Boolean))] : [];
  } catch {
    return [];
  }
}

async function persistPins() {
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(state.pinnedSessionIds));
  if (!state.live) return;
  try {
    const res = await liveFetch("/api/atlas/pins", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: state.pinnedSessionIds }),
    });
    if (res.ok) {
      const pins = await res.json();
      state.pinnedSessionIds = pins.sessionIds ?? state.pinnedSessionIds;
      state.pinnedChatItems = pins.items ?? state.pinnedChatItems;
    }
  } catch {
    // localStorage remains the fallback
  }
}

function isPinned(sessionId) {
  return state.pinnedSessionIds.includes(sessionId);
}

function togglePin(sessionId) {
  if (!sessionId) return;
  if (isPinned(sessionId)) {
    state.pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId);
  } else {
    state.pinnedSessionIds = [...state.pinnedSessionIds, sessionId];
  }
  persistPins();
  render();
}

function inboxRowSummary(c) {
  if (c.activityLevel === "active" && c.signals?.length) {
    return esc(describeActivitySignals(c.signals).join(" · "));
  }
  if (c.liveSummary) return esc(c.liveSummary);
  return "";
}

function resolveInboxChat(sessionId) {
  const active = state.activeChats.find((c) => c.sessionId === sessionId);
  if (active) return active;
  const session = sessionById(sessionId);
  if (session) {
    return {
      sessionId,
      title: session.title,
      workspace: session.workspace,
      updatedAt: session.updatedAt,
      activityLevel: "idle",
      signals: [],
      liveSummary: session.liveSummary ?? segmentsForSession(sessionId).at(-1)?.preview ?? "",
    };
  }
  return {
    sessionId,
    title: sessionId.slice(0, 8),
    workspace: "unknown",
    updatedAt: new Date(0).toISOString(),
    activityLevel: "idle",
    signals: [],
    liveSummary: "",
  };
}

function pinnedChats() {
  const activeById = new Map(state.activeChats.map((c) => [c.sessionId, c]));
  const byId = new Map(state.pinnedChatItems.map((c) => [c.sessionId, c]));
  return state.pinnedSessionIds.map((sessionId) => {
    const active = activeById.get(sessionId);
    if (active) return active;
    const item = byId.get(sessionId);
    if (item) {
      return {
        sessionId: item.sessionId,
        title: item.title,
        workspace: item.workspace,
        updatedAt: item.updatedAt,
        activityLevel: item.activityLevel ?? "idle",
        signals: item.signals ?? [],
        liveSummary: item.liveSummary ?? "",
      };
    }
    return resolveInboxChat(sessionId);
  });
}

async function loadSpine(sessionId, { refresh = false } = {}) {
  if (!refresh && state.spines[sessionId]) return state.spines[sessionId];
  if (!state.live && state.SPINE[sessionId]) {
    state.spines[sessionId] = annotateSpine(state.SPINE[sessionId], sessionId);
    return state.spines[sessionId];
  }
  const res = await liveFetch(`/api/atlas/spine/${sessionId}`);
  if (!res.ok) throw new Error(`Spine ${res.status}`);
  const spine = await res.json();
  state.spines[sessionId] = annotateSpine(spine, sessionId);
  return state.spines[sessionId];
}

function spineDigest(spine) {
  if (!spine) return "0";
  const turns = (spine.turns ?? [])
    .map((t) => `${t.n}:${t.role}:${t.bubbleId}:${t.at ?? ""}:${(t.preview ?? "").slice(0, 96)}`)
    .join("|");
  const branches = (spine.branches ?? []).map((b) => b.id).join(",");
  return `${spine.revision ?? turns.length}#${turns}#${branches}`;
}

async function refreshSpine(sessionId) {
  if (!state.live || !sessionId) return false;
  const prevDigest = spineDigest(state.spines[sessionId]);
  try {
    await loadSpine(sessionId, { refresh: true });
  } catch {
    return false;
  }
  return spineDigest(state.spines[sessionId]) !== prevDigest;
}

function scrollSnapshot() {
  const main = root.querySelector(".session-spine-main");
  return {
    windowY: window.scrollY,
    mainTop: main?.scrollTop ?? 0,
    nearBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 140,
  };
}

function minimapScrollSnapshot() {
  const groups = root.querySelector(".minimap-groups");
  if (!groups) return null;
  return {
    scrollTop: groups.scrollTop,
    nearBottom: groups.scrollTop + groups.clientHeight >= groups.scrollHeight - 24,
  };
}

function restoreMinimapScroll(snapshot) {
  if (!snapshot) return;
  const groups = root.querySelector(".minimap-groups");
  if (!groups) return;
  groups.scrollTop = snapshot.nearBottom ? groups.scrollHeight : Math.min(snapshot.scrollTop, groups.scrollHeight);
}

function scrollSessionToBottom() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  const groups = root.querySelector(".minimap-groups");
  if (groups) groups.scrollTop = groups.scrollHeight;
}

function restoreScrollSnapshot(snapshot) {
  const main = root.querySelector(".session-spine-main");
  window.scrollTo({ top: snapshot.windowY });
  if (main) main.scrollTop = snapshot.mainTop;
  if (snapshot.nearBottom) {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }
}

function renderPreservingScroll() {
  const snapshot = scrollSnapshot();
  const minimapSnapshot = minimapScrollSnapshot();
  const minimapPinned = state._minimapPinned;
  const searchTurn = state._searchHighlightTurn;
  state._minimapPreserveScroll = true;
  render();
  state._minimapPreserveScroll = false;
  state._minimapPinned = minimapPinned;
  restoreScrollSnapshot(snapshot);
  restoreMinimapScroll(minimapSnapshot);
  if (minimapPinned) {
    const chunk = document.getElementById(minimapPinned);
    chunk?.classList.add("minimap-current");
  }
  if (searchTurn != null) markSearchTurn(searchTurn, { flash: false });
}

function markSearchTurn(turnN, { flash = true } = {}) {
  if (turnN == null) return;
  state._searchHighlightTurn = turnN;
  root.querySelectorAll(".spine-turn-search-hit").forEach((el) => {
    el.classList.remove("spine-turn-search-hit", "spine-turn-flash");
  });
  const turnEl = document.getElementById(`turn-${turnN}`);
  if (!turnEl) return;
  turnEl.classList.add("spine-turn-search-hit");
  if (flash) flashSearchTurn(turnN);
}

function flashSearchTurn(turnN) {
  const turnEl = document.getElementById(`turn-${turnN}`);
  if (!turnEl) return;
  root.querySelectorAll(".spine-turn.spine-turn-flash").forEach((el) => {
    el.classList.remove("spine-turn-flash");
  });
  void turnEl.offsetWidth;
  turnEl.classList.add("spine-turn-flash");
  clearTimeout(state._searchFlashTimer);
  state._searchFlashTimer = setTimeout(() => {
    turnEl.classList.remove("spine-turn-flash");
  }, 1400);
}

function clearSearchTurnHighlight() {
  if (state._searchHighlightTurn == null) return;
  state._searchHighlightTurn = null;
  root.querySelectorAll(".spine-turn-search-hit, .spine-turn-flash").forEach((el) => {
    el.classList.remove("spine-turn-search-hit", "spine-turn-flash");
  });
}

function isSearchTurnInView(turnN) {
  const el = document.getElementById(`turn-${turnN}`);
  if (!el) return false;
  const line = window.innerHeight * 0.22;
  const rect = el.getBoundingClientRect();
  return rect.top <= line + 96 && rect.bottom >= line - 48;
}

function scrollToTurn(turnN, { flash = true } = {}) {
  const turnEl = document.getElementById(`turn-${turnN}`);
  if (!turnEl) return false;
  const line = window.innerHeight * 0.22;
  const rect = turnEl.getBoundingClientRect();
  state._searchScrollLock = true;
  window.scrollBy({ top: rect.top - line + 12, behavior: "smooth" });
  markSearchTurn(turnN, { flash });
  const chunkId = chunkIdForTurn(state.sessionId, turnN);
  if (chunkId) {
    const minimap = root.querySelector(".spine-minimap");
    minimap?.querySelectorAll(".minimap-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.scrollTarget === chunkId);
    });
  }
  return true;
}

function annotateSpine(spine, sessionId) {
  const segs = resolveSegments(sessionId, spine);
  for (const turn of spine.turns) {
    if (turn.role !== "user") continue;
    const seg = segs.find((s) => turn.n >= s.turnStart && turn.n <= s.turnEnd);
    turn.segmentId = seg?.id;
  }
  return spine;
}

function themeById(id) {
  return state.THEMES.find((t) => t.id === id);
}

function sessionById(id) {
  const indexed = state.SESSIONS.find((s) => s.id === id);
  if (indexed) return indexed;
  const active = state.activeChats.find((c) => c.sessionId === id);
  if (!active) return undefined;
  return {
    id: active.sessionId,
    title: active.title,
    workspace: active.workspace,
    updatedAt: active.updatedAt,
    liveSummary: active.liveSummary,
  };
}

function segmentsForTheme(themeId) {
  return state.SEGMENTS.filter((s) => s.themeId === themeId).sort(
    (a, b) => new Date(sessionById(b.sessionId)?.updatedAt ?? 0) - new Date(sessionById(a.sessionId)?.updatedAt ?? 0),
  );
}

function resolveSegments(sessionId, spine) {
  const indexed = state.SEGMENTS.filter((s) => s.sessionId === sessionId);
  if (indexed.length) return indexed;
  return spine?.segments ?? state.spines[sessionId]?.segments ?? [];
}

function segmentsForSession(sessionId) {
  return resolveSegments(sessionId, state.spines[sessionId]);
}

function sessionsForTheme(themeId) {
  const ids = [...new Set(segmentsForTheme(themeId).map((s) => s.sessionId))];
  return ids
    .map((id) => sessionById(id))
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function themeStats(themeId) {
  const segs = segmentsForTheme(themeId);
  return {
    segmentCount: segs.length,
    sessionCount: new Set(segs.map((s) => s.sessionId)).size,
    subthemeCount: subthemesForTheme(themeId).length,
  };
}

function subthemeLabel(seg) {
  return (seg.groupLabel || seg.subtheme || seg.preview || "Topic").trim();
}

function subthemeKeyFor(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "topic";
}

function subthemesForTheme(themeId) {
  const groups = new Map();
  for (const seg of segmentsForTheme(themeId)) {
    const label = subthemeLabel(seg);
    const key = subthemeKeyFor(label);
    const cur = groups.get(key) ?? { key, label, segments: [], sessionIds: new Set() };
    cur.segments.push(seg);
    cur.sessionIds.add(seg.sessionId);
    groups.set(key, cur);
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      label: g.label,
      segments: g.segments,
      sessionCount: g.sessionIds.size,
      segmentCount: g.segments.length,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount || b.segmentCount - a.segmentCount);
}

function segmentsForSubtheme(themeId, subthemeKey) {
  return segmentsForTheme(themeId).filter((seg) => subthemeKeyFor(subthemeLabel(seg)) === subthemeKey);
}

function subthemeByKey(themeId, subthemeKey) {
  return subthemesForTheme(themeId).find((s) => s.key === subthemeKey) ?? null;
}

function splitSubthemes(subs) {
  const primary = subs.filter((s) => s.sessionCount >= 2);
  const inline = subs.filter((s) => s.sessionCount < 2);
  return { primary, inline };
}

function renderSubthemeCard(st, themeId, themeColor) {
  return `
    <div class="subtheme-card" data-subtheme-open="${esc(st.key)}" data-theme-id="${esc(themeId)}" style="--theme-color:${themeColor}">
      <div class="subtheme-card-accent"></div>
      <div class="subtheme-card-body">
        <div class="subtheme-card-head">
          <h3>${esc(st.label)}</h3>
          <span class="theme-counts">${st.sessionCount} chat${st.sessionCount === 1 ? "" : "s"}</span>
        </div>
        <div class="subtheme-card-meta">${st.segmentCount} segment${st.segmentCount === 1 ? "" : "s"}</div>
      </div>
    </div>`;
}

function snapshotRoute() {
  return {
    view: state.view,
    themeId: state.themeId,
    subthemeKey: state.subthemeKey,
    sessionId: state.sessionId,
    segmentId: state.segmentId,
    expandContext: state.expandContext,
    highlightTurn: state.highlightTurn,
  };
}

function buildUrlFromState() {
  const sp = new URLSearchParams(location.search);
  sp.set("variant", state.variant);
  if (state.view === "segment" && state.expandContext) sp.set("expand", "1");
  else sp.delete("expand");

  let hash = "#/";
  if (state.view === "theme" && state.themeId) {
    hash = `#/theme/${encodeURIComponent(state.themeId)}`;
  } else if (state.view === "subtheme" && state.themeId && state.subthemeKey) {
    hash = `#/theme/${encodeURIComponent(state.themeId)}/sub/${encodeURIComponent(state.subthemeKey)}`;
  } else if (state.view === "session" && state.sessionId) {
    const sid = encodeURIComponent(state.sessionId);
    if (state.themeId && state.subthemeKey) {
      hash = `#/theme/${encodeURIComponent(state.themeId)}/sub/${encodeURIComponent(state.subthemeKey)}/chat/${sid}`;
    } else if (state.themeId) {
      hash = `#/theme/${encodeURIComponent(state.themeId)}/chat/${sid}`;
    } else {
      hash = `#/chat/${sid}`;
    }
  } else if (state.view === "segment" && state.segmentId) {
    hash = `#/seg/${encodeURIComponent(state.segmentId)}`;
  }

  const qs = sp.toString();
  return `${location.pathname}${qs ? `?${qs}` : ""}${hash}`;
}

function syncUrl({ replace = false } = {}) {
  const url = buildUrlFromState();
  if (`${location.pathname}${location.search}${location.hash}` === url) return;
  const entry = { atlas: snapshotRoute() };
  if (replace) history.replaceState(entry, "", url);
  else history.pushState(entry, "", url);
}

function parseRouteFromLocation() {
  const sp = new URLSearchParams(location.search);
  const parts = (location.hash.slice(1) || "/").split("/").filter(Boolean);
  const expandContext = sp.get("expand") === "1";
  const empty = {
    view: "home",
    themeId: null,
    subthemeKey: null,
    sessionId: null,
    segmentId: null,
    expandContext: false,
    highlightTurn: null,
  };

  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) return empty;

  if (parts[0] === "theme" && parts[1]) {
    const themeId = decodeURIComponent(parts[1]);
    if (parts[2] === "sub" && parts[3]) {
      const subthemeKey = decodeURIComponent(parts[3]);
      if (parts[4] === "chat" && parts[5]) {
        const sessionId = decodeURIComponent(parts[5]);
        return { view: "session", themeId, subthemeKey, sessionId, segmentId: null, expandContext: false };
      }
      return { view: "subtheme", themeId, subthemeKey, sessionId: null, segmentId: null, expandContext: false };
    }
    if (parts[2] === "chat" && parts[3]) {
      return {
        view: "session",
        themeId,
        subthemeKey: null,
        sessionId: decodeURIComponent(parts[3]),
        segmentId: null,
        expandContext: false,
      };
    }
    return { view: "theme", themeId, subthemeKey: null, sessionId: null, segmentId: null, expandContext: false };
  }

  if (parts[0] === "chat" && parts[1]) {
    return {
      view: "session",
      themeId: null,
      subthemeKey: null,
      sessionId: decodeURIComponent(parts[1]),
      segmentId: null,
      expandContext: false,
    };
  }

  if (parts[0] === "seg" && parts[1]) {
    const segmentId = decodeURIComponent(parts[1]);
    const seg = state.SEGMENTS.find((x) => x.id === segmentId);
    return {
      view: "segment",
      themeId: seg?.themeId ?? null,
      subthemeKey: seg ? subthemeKeyFor(subthemeLabel(seg)) : null,
      sessionId: seg?.sessionId ?? null,
      segmentId,
      expandContext,
    };
  }

  return empty;
}

function applyRoute(route, { replaceUrl = false } = {}) {
  let next = { ...route };
  if (next.themeId && !themeById(next.themeId)) {
    next = { view: "home", themeId: null, subthemeKey: null, sessionId: null, segmentId: null, expandContext: false };
  }
  if (next.subthemeKey && next.themeId && !subthemeByKey(next.themeId, next.subthemeKey)) {
    next = { view: "theme", themeId: next.themeId, subthemeKey: null, sessionId: null, segmentId: null, expandContext: false };
  }
  if (next.sessionId && !sessionById(next.sessionId)) {
    next = next.themeId
      ? { view: "theme", themeId: next.themeId, subthemeKey: null, sessionId: null, segmentId: null, expandContext: false }
      : { view: "home", themeId: null, subthemeKey: null, sessionId: null, segmentId: null, expandContext: false };
  }
  if (next.segmentId && !state.SEGMENTS.find((x) => x.id === next.segmentId)) {
    next = { view: "home", themeId: null, subthemeKey: null, sessionId: null, segmentId: null, expandContext: false };
  }

  const prevView = state.view;
  const prevSessionId = state.sessionId;
  const hasScrollTarget =
    next.highlightTurn != null ||
    next.segmentId != null ||
    state._pendingScrollTurn != null ||
    state._searchHighlightTurn != null;
  const openingSession =
    next.view === "session" &&
    next.sessionId &&
    (prevView !== "session" || prevSessionId !== next.sessionId) &&
    !hasScrollTarget;

  Object.assign(state, next);
  if (openingSession) state._scrollToBottomOnOpen = true;
  syncUrl({ replace: replaceUrl });

  const crumbBar = document.getElementById("crumb-bar");
  if (crumbBar) crumbBar.classList.toggle("hidden", state.view === "home");

  if (state.view === "session" && state.sessionId) {
    loadSpine(state.sessionId, { refresh: true }).then(() => render()).catch(() => render());
    syncLivePoll();
  } else if (state.view === "segment" && state.sessionId) {
    loadSpine(state.sessionId, { refresh: true }).then(() => render()).catch(() => render());
    syncLivePoll();
  } else if (state.view === "home") {
    stopLivePoll();
    syncLivePoll();
  } else {
    stopLivePoll();
  }
}

function navigate(view, params = {}) {
  applyRoute(
    {
      view,
      themeId: null,
      subthemeKey: null,
      sessionId: null,
      segmentId: null,
      highlightTurn: null,
      expandContext: false,
      ...params,
    },
    { replaceUrl: false },
  );
  render();
}

function spineChunkGroups(sessionId) {
  const spine = state.spines[sessionId] ?? state.SPINE[sessionId];
  if (!spine) return [];
  const segs = segmentsForSession(sessionId);
  const byTurn = new Map();
  for (const turn of spine.turns) {
    const list = byTurn.get(turn.n) ?? [];
    list.push(turn);
    byTurn.set(turn.n, list);
  }
  const groups = [];
  for (const n of [...byTurn.keys()].sort((a, b) => a - b)) {
    const turns = byTurn.get(n);
    const user = turns.find((t) => t.role === "user");
    const assistant = turns.filter((t) => t.role === "assistant").at(-1);
    if (!user && !assistant) continue;
    const seg = segs.find((s) => n >= s.turnStart && n <= s.turnEnd);
    const meta = {
      n,
      userPreview: user?.preview ?? "",
      replyPreview: assistant?.preview ?? "",
      segment: seg,
      label: seg ? subthemeLabel(seg) : null,
      summary: seg?.preview ?? assistant?.preview ?? user?.preview ?? "",
    };
    if (!user && groups.length) {
      const last = groups[groups.length - 1];
      last.turnNs.push(n);
      if (assistant?.preview) last.replyPreview = assistant.preview;
      if (meta.label && !last.label) last.label = meta.label;
    } else {
      groups.push({ ...meta, turnNs: [n] });
    }
  }
  return groups;
}

function miniLabel(text, max = 30) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "Turn";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function minimapLabel(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t || "Turn";
}

function sessionHasIndexedSegments(sessionId) {
  return state.SEGMENTS.some((s) => s.sessionId === sessionId);
}

function minimapTopicKey(sessionId, chunk) {
  if (chunk.segment && sessionHasIndexedSegments(sessionId)) {
    return minimapGroupKey(chunk.segment);
  }
  return normalizeMinimapGroupKey(chunk.userPreview || chunk.replyPreview || chunk.summary);
}

function normalizeMinimapGroupKey(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return "turn";
  if (/browser_element|tag:\s*\w+/i.test(t)) return "ui-click";
  if (t.includes("task follow-up") || t.includes("subagent")) return "follow-up";
  if (t.includes("modal flashes") || t.includes("modal flash")) return "search-modal";
  if (t.includes("highlights the left convo") || t.includes("highlight the left")) return "search-highlight";
  if (t.includes("loader") && (t.includes("search") || t.includes("typing"))) return "search-loader";
  if (t.includes("speed up the search") || t.includes("show up when i search")) return "search-index";
  if (t.includes("minimap scroll")) return "minimap-scroll";
  if (t.includes("groupings") || t.includes("doesnt seem right")) return "map-layout";
  if (t.includes("scroll") && t.includes("bottom")) return "scroll-bottom";
  if (t.includes("white box") || t.includes("better looking icon") || t.includes("better icon")) return "app-icon";
  if (t.includes("app menu") || t.includes("show up in my app")) return "app-menu";
  if (t.includes("quit and reopen")) return "app-restart";
  if (t.includes("pinned")) return "pinned-ui";
  if (t.includes("untitled")) return "untitled";
  if (t.includes("favicon")) return "favicon";
  if (t.includes("agent requests") || t.includes("updating our db")) return "live-polling";
  if (t.includes("gaps are a problem")) return "layout-gaps";
  if (t.includes("proto-switcher") || t.includes("prototype banner")) return "remove-proto";
  if (t.includes("lucide") || t.includes("pin icon")) return "icons-ui";
  if (t.includes("link on these convos") || t.includes("open in cursor")) return "cursor-link";
  if (t.includes("remove more/less")) return "active-list";
  return t.slice(0, 48);
}

function minimapRunLabel(sessionId, run) {
  const chunk = run.chunks.find((c) => c.userPreview?.trim()) ?? run.chunks[0];
  if (chunk?.segment && sessionHasIndexedSegments(sessionId)) {
    return minimapGroupTitle(chunk.segment);
  }
  const preview = chunk?.userPreview || chunk?.replyPreview || chunk?.summary || "";
  const label = minimapLabel(preview);
  return label.length <= 52 ? label : `${label.slice(0, 51)}…`;
}

function minimapThemeColor(sessionId, run) {
  const seg = run.chunks.find((c) => c.segment)?.segment;
  if (seg) return themeById(seg.themeId)?.color ?? null;
  const segs = segmentsForSession(sessionId);
  return segs[0] ? themeById(segs[0].themeId)?.color ?? null : null;
}

function minimapGroupKey(segment) {
  if (!segment) return "__ungrouped__";
  return `${segment.themeId}:${subthemeLabel(segment)}`;
}

function minimapGroupTitle(segment) {
  if (!segment) return "Other";
  return subthemeLabel(segment);
}

/** Group only consecutive related turns; one-offs stay inline without a header. */
function minimapGroups(sessionId) {
  const chunks = spineChunkGroups(sessionId);
  const runs = [];
  let run = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const key = minimapTopicKey(sessionId, chunk);
    if (run && run.key === key) {
      run.chunks.push(chunk);
    } else {
      if (run) runs.push(run);
      run = { key, chunks: [chunk] };
    }
  }
  if (run) runs.push(run);

  return coalesceInlineMinimapGroups(
    runs.map((run, gi) => {
      const inline = run.chunks.length === 1;
      const items = run.chunks.map((chunk) => ({
        num: chunks.indexOf(chunk) + 1,
        chunk,
        label: minimapLabel(chunk.userPreview || chunk.replyPreview || chunk.summary),
      }));
      return {
        id: `mg-${gi}`,
        inline,
        segId: run.chunks[0]?.segment?.id ?? null,
        groupKey: run.key,
        label: inline ? null : minimapRunLabel(sessionId, run),
        color: minimapThemeColor(sessionId, run),
        items,
      };
    }),
  );
}

/** Consecutive one-offs share one inline container so row spacing CSS can apply. */
function coalesceInlineMinimapGroups(groups) {
  const out = [];
  let inlineBatch = null;
  for (const g of groups) {
    if (g.inline) {
      if (!inlineBatch) {
        inlineBatch = { ...g, items: [...g.items] };
        out.push(inlineBatch);
      } else {
        inlineBatch.items.push(...g.items);
      }
    } else {
      inlineBatch = null;
      out.push(g);
    }
  }
  return out;
}

function renderSpineMinimap(sessionId) {
  const spine = state.spines[sessionId] ?? state.SPINE[sessionId];
  const groups = minimapGroups(sessionId);
  if (!groups.length) return "";
  const branches = spine?.branches ?? [];

  state._minimapIndex = {};
  for (const g of groups) {
    for (const it of g.items) state._minimapIndex[`chunk-${it.chunk.n}`] = g.id;
  }

  const groupsHtml = groups
    .map((g) => {
      const swatch = g.color ?? "var(--dim)";
      const itemsHtml = g.items
        .map((it) => {
          const forked = branches.some((b) => it.chunk.turnNs.includes(b.parentTurn));
          return `
            <button type="button" class="minimap-item" data-scroll-target="chunk-${it.chunk.n}">
              <span class="minimap-dot"></span>
              <span class="minimap-num">${String(it.num).padStart(2, "0")}</span>
              <span class="minimap-label">${esc(it.label)}</span>
              ${forked ? `<span class="minimap-fork" title="pruned branch">&#8627;</span>` : ""}
              <span class="minimap-badge">current</span>
            </button>`;
        })
        .join("");
      if (g.inline) {
        return `<div class="minimap-inline" data-group="${g.id}">${itemsHtml}</div>`;
      }
      return `
        <section class="minimap-group" data-group="${g.id}" style="--minimap-band-color:${swatch}">
          <div class="minimap-group-head">
            <span class="minimap-swatch" style="background:${swatch}"></span>
            <span class="minimap-group-label">${esc(g.label)}</span>
            <span class="minimap-count">${g.items.length}</span>
          </div>
          <div class="minimap-items">${itemsHtml}</div>
        </section>`;
    })
    .join("");

  return `
    <aside class="spine-minimap" aria-label="Conversation map">
      <div class="minimap-title">Map</div>
      <div class="minimap-groups">${groupsHtml}</div>
      <div class="minimap-legend">
        <span><i class="legend-dot current"></i>Current turn</span>
        <span><i class="legend-dot theme"></i>Category</span>
        <span><i class="legend-dot other"></i>One-off</span>
      </div>
    </aside>`;
}

function bindSpineMinimap() {
  const minimap = root.querySelector(".spine-minimap");
  if (!minimap) return;

  const chunkEls = () => [...root.querySelectorAll(".session-spine-main [id^='chunk-']")];
  const readingLine = () => window.innerHeight * 0.22;

  const setChunkHighlight = (id) => {
    chunkEls().forEach((el) => {
      el.classList.toggle("minimap-current", Boolean(id) && el.id === id);
    });
  };

  const setMinimapActive = (id, { scroll = true } = {}) => {
    if (!id) return;
    const sameActive = state._minimapLastActiveId === id;
    state._minimapLastActiveId = id;
    let matched = false;
    const shouldScroll = scroll && !state._minimapPreserveScroll && !sameActive;
    minimap.querySelectorAll(".minimap-item").forEach((el) => {
      const on = el.dataset.scrollTarget === id;
      el.classList.toggle("active", on);
      if (on) {
        matched = true;
        if (shouldScroll) {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    });
    const groupId = state._minimapIndex?.[id];
    minimap.querySelectorAll(".minimap-group").forEach((el) => {
      const inGroup = el.dataset.group === groupId;
      el.classList.toggle("active", inGroup);
      el.classList.toggle("active-collapsed", inGroup && !matched);
    });
  };

  const setActiveFromClick = (id) => {
    state._minimapLastActiveId = id;
    setMinimapActive(id, { scroll: true });
    setChunkHighlight(id);
  };

  const activeChunkId = () => {
    if (state._minimapPinned) return state._minimapPinned;
    const targets = chunkEls();
    if (!targets.length) return null;
    const line = readingLine();

    // If multiple chunks span the reading line, pick the innermost (latest) one.
    let containingId = null;
    let containingTop = -Infinity;
    for (const el of targets) {
      const rect = el.getBoundingClientRect();
      if (rect.top <= line && rect.bottom > line && rect.top > containingTop) {
        containingTop = rect.top;
        containingId = el.id;
      }
    }
    if (containingId) return containingId;

    let bestId = targets[0].id;
    for (const el of targets) {
      if (el.getBoundingClientRect().top <= line) bestId = el.id;
      else break;
    }
    return bestId;
  };

  const syncActive = () => {
    setChunkHighlight(null);
    setMinimapActive(activeChunkId());
  };

  const scrollToChunk = (id) => {
    const target = document.getElementById(id);
    if (!target) return;
    const line = readingLine();
    const rect = target.getBoundingClientRect();
    // Land the reading line inside the chunk, not on its top edge (avoids overlap with prior chunk).
    window.scrollBy({ top: rect.top - line + 12, behavior: "smooth" });
  };

  const flashChunk = (id) => {
    const target = document.getElementById(id);
    if (!target) return;
    root.querySelectorAll(".spine-chunk.minimap-flash").forEach((el) => {
      el.classList.remove("minimap-flash");
    });
    // Retrigger CSS animation if the same chunk is clicked again.
    void target.offsetWidth;
    target.classList.add("minimap-flash");
    clearTimeout(state._minimapFlashTimer);
    state._minimapFlashTimer = setTimeout(() => {
      target.classList.remove("minimap-flash");
    }, 1400);
  };

  const releasePin = () => {
    const pinned = state._minimapPinned;
    state._minimapPinned = null;
    if (pinned) {
      setMinimapActive(pinned);
      setChunkHighlight(pinned);
    } else {
      syncActive();
    }
  };

  minimap.querySelectorAll("[data-scroll-target]").forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.scrollTarget;
      state._minimapPinned = id;
      clearTimeout(state._minimapPinTimer);
      setActiveFromClick(id);
      scrollToChunk(id);
      flashChunk(id);
    };
  });

  if (state._minimapScroll) window.removeEventListener("scroll", state._minimapScroll, { passive: true });
  if (state._minimapScrollEnd) window.removeEventListener("scrollend", state._minimapScrollEnd);

  let ticking = false;
  state._minimapScroll = () => {
    if (state._searchScrollLock) return;
    if (state._searchHighlightTurn != null && !isSearchTurnInView(state._searchHighlightTurn)) {
      clearSearchTurnHighlight();
    }
    if (state._minimapPinned) return;
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      syncActive();
    });
  };
  state._minimapScrollEnd = () => {
    if (state._searchScrollLock) {
      state._searchScrollLock = false;
      return;
    }
    if (state._minimapPinned) {
      clearTimeout(state._minimapPinTimer);
      releasePin();
    } else {
      syncActive();
    }
  };

  window.addEventListener("scroll", state._minimapScroll, { passive: true });
  window.addEventListener("scrollend", state._minimapScrollEnd, { passive: true });

  const sessionId = state.sessionId;
  const pendingTurn = state._pendingScrollTurn;
  const spineReady = Boolean((state.spines[sessionId] ?? state.SPINE[sessionId])?.turns?.length);
  const shouldScrollToBottom =
    state.view === "session" &&
    sessionId &&
    state._scrollToBottomOnOpen &&
    spineReady &&
    pendingTurn == null &&
    state._searchHighlightTurn == null &&
    !state.segmentId;

  if (shouldScrollToBottom) {
    state._scrollToBottomOnOpen = false;
    requestAnimationFrame(() => {
      scrollSessionToBottom();
      const chunks = spineChunkGroups(sessionId);
      const last = chunks.at(-1);
      if (last) {
        const id = `chunk-${last.n}`;
        state._minimapPinned = null;
        setMinimapActive(id, { scroll: true });
        setChunkHighlight(id);
      }
    });
  } else {
    syncActive();
  }

  if (state.view === "session" && sessionId) {
    if (pendingTurn != null) {
      const fromSearch = state._searchHighlightTurn === pendingTurn;
      requestAnimationFrame(() => {
        let scrolled = false;
        if (fromSearch) {
          scrolled = scrollToTurn(pendingTurn);
          if (!scrolled) {
            const chunkId = chunkIdForTurn(sessionId, pendingTurn);
            if (chunkId) {
              scrollToChunk(chunkId);
              markSearchTurn(pendingTurn);
              scrolled = true;
            }
          }
        } else {
          const chunkId = chunkIdForTurn(sessionId, pendingTurn);
          if (chunkId) {
            state._minimapPinned = chunkId;
            setMinimapActive(chunkId);
            setChunkHighlight(chunkId);
            scrollToChunk(chunkId);
            flashChunk(chunkId);
            scrolled = true;
          }
        }
        if (scrolled) state._pendingScrollTurn = null;
      });
    } else if (state.segmentId && state._searchHighlightTurn == null) {
      const seg = state.SEGMENTS.find((x) => x.id === state.segmentId);
      const chunkId = seg ? chunkIdForTurn(sessionId, seg.turnStart) : null;
      if (chunkId) {
        state._minimapPinned = chunkId;
        setMinimapActive(chunkId);
        requestAnimationFrame(() => {
          scrollToChunk(chunkId);
          flashChunk(chunkId);
        });
      }
    }
  }
}

function renderSpineHtml(sessionId, highlightSegmentId = null) {
  const spine = state.spines[sessionId] ?? state.SPINE[sessionId];
  if (!spine) {
    return `<p style="color:var(--muted);font-size:13px">Loading spine…</p>`;
  }
  const chunks = spineChunkGroups(sessionId);
  let html = `<div class="spine">`;
  for (const chunk of chunks) {
    html += `<div class="spine-chunk" id="chunk-${chunk.n}">`;
    for (const turnN of chunk.turnNs) {
      const chunkTurns = spine.turns.filter((t) => t.n === turnN);
      for (const turn of chunkTurns) {
        const seg = state.SEGMENTS.find((s) => s.id === turn.segmentId);
        const theme = seg ? themeById(seg.themeId) : null;
        const hl = highlightSegmentId && turn.segmentId === highlightSegmentId;
        const continuation = turnN !== chunk.n;
        html += `
        <div class="spine-turn${continuation ? " spine-turn-continuation" : ""}" id="turn-${turn.n}">
          <div class="spine-rail"><div class="spine-node ${turn.role}"></div><div class="spine-line"></div></div>
          <div class="spine-body ${hl ? "highlight" : ""}" style="${hl && theme ? `border-left:3px solid ${theme.color}` : ""}">
            <div class="spine-body-head">
              <span class="role">${turn.role} · turn ${turn.n}</span>
              ${turn.at ? `<span class="spine-time">${esc(fmtTime(turn.at))}</span>` : ""}
            </div>
            ${esc(turn.preview)}
            ${seg && turn.role === "user" ? `<div style="margin-top:6px">${subthemeChip(subthemeLabel(seg), theme?.color)}</div>` : ""}
          </div>
        </div>`;
      }
    }
    const chunkBranches = (spine.branches ?? []).filter((b) => chunk.turnNs.includes(b.parentTurn));
    for (const branch of chunkBranches) {
      html += `
        <div class="branch-fork">
          <div class="label">↳ pruned branch · ${esc(branch.label)}</div>
          <div class="spine-body" style="opacity:0.65;border-style:dashed">
            <div class="role">orphan · pruned</div>
            ${esc(branch.orphanPreview)}
          </div>
        </div>`;
    }
    html += `</div>`;
  }
  html += renderSpineWorkingBubble(state.sessionActivity);
  html += `</div>`;
  return html;
}

function renderSessionSpineView(sessionId, highlightSegmentId = null) {
  const segmentHighlight = state._searchHighlightTurn != null ? null : highlightSegmentId;
  return `
    <div class="session-spine-layout">
      <div class="session-spine-main">${renderSpineHtml(sessionId, segmentHighlight)}</div>
      ${renderSpineMinimap(sessionId)}
    </div>`;
}

function chunkIdForTurn(sessionId, turnN) {
  for (const chunk of spineChunkGroups(sessionId)) {
    if (chunk.turnNs.includes(turnN)) return `chunk-${chunk.n}`;
  }
  return null;
}

function chip(themeId) {
  const t = themeById(themeId);
  if (!t) return "";
  return `<span class="chip" style="color:${t.color};border-color:${t.color}">${esc(t.label)}</span>`;
}

function subthemeChip(label, color = "var(--muted)") {
  if (!label) return "";
  return `<span class="chip subtheme-chip" style="color:${color};border-color:${color}">${esc(label)}</span>`;
}

function sessionCard(s) {
  const segs = segmentsForSession(s.id);
  const chips = [...new Set(segs.map((x) => x.themeId))].map(chip).join("");
  return `
    <div class="card" data-session="${s.id}">
      <h3>${esc(s.title)}</h3>
      <div class="meta">${esc(s.workspace)} · ${fmtDate(s.updatedAt)}</div>
      <div>${chips}</div>
    </div>`;
}

function segmentRow(seg, showSession = true) {
  const s = sessionById(seg.sessionId);
  return `
    <div class="seg-item" data-segment="${seg.id}" data-session="${seg.sessionId}">
      ${showSession ? `<div style="font-weight:600;margin-bottom:4px">${esc(s?.title || "?")}</div>` : ""}
      <div style="color:var(--muted);margin-bottom:4px">turns ${seg.turnStart}–${seg.turnEnd}</div>
      ${esc(seg.preview)}
    </div>`;
}

function activityLabel(level) {
  if (level === "active") return "in flight";
  if (level === "recent") return "recent";
  return "idle";
}

function describeActivitySignals(signals = []) {
  const labels = [];
  for (const s of signals) {
    if (s === "generating_bubbles") labels.push("generating");
    else if (s === "loading_tools") labels.push("running tools");
    else if (s === "blocking_pending_actions") labels.push("waiting for approval");
    else if (s.startsWith("composer_status:")) labels.push(s.slice("composer_status:".length).replace(/_/g, " "));
  }
  return labels;
}

function renderSessionActivityBadge(activity) {
  if (!activity || activity.activityLevel === "idle") {
    return `<div id="session-activity" class="session-activity hidden" aria-hidden="true"></div>`;
  }
  if (activity.activityLevel === "active") {
    const detail = describeActivitySignals(activity.signals).join(" · ") || "working";
    return `<div id="session-activity" class="session-activity working" aria-live="polite"><span class="session-activity-dot" aria-hidden="true"></span><span>Assistant ${esc(detail)}</span></div>`;
  }
  return `<div id="session-activity" class="session-activity recent" aria-live="polite">Updated recently · not working now</div>`;
}

function renderSpineWorkingBubble(activity) {
  if (!activity || activity.activityLevel !== "active") return "";
  const detail = describeActivitySignals(activity.signals).join(" · ") || "working";
  return `
    <div id="spine-working" class="spine-working" aria-live="polite">
      <div class="spine-turn">
        <div class="spine-rail"><div class="spine-node assistant working"></div><div class="spine-line"></div></div>
        <div class="spine-body spine-body-working">
          <div class="spine-body-head">
            <span class="role">Assistant · now</span>
          </div>
          <div class="spine-working-text">
            <span class="session-activity-dot" aria-hidden="true"></span>
            <span>${esc(detail)}…</span>
          </div>
        </div>
      </div>
    </div>`;
}

function updateWorkingIndicators() {
  updateSessionActivityUi();
  const spine = root.querySelector(".session-spine-main .spine");
  if (!spine || state.view !== "session") return;
  const existing = document.getElementById("spine-working");
  const next = renderSpineWorkingBubble(state.sessionActivity);
  if (!next) {
    existing?.remove();
    return;
  }
  if (existing) existing.outerHTML = next;
  else spine.insertAdjacentHTML("beforeend", next);
}

function normalizeActivity(raw) {
  if (!raw) return null;
  return {
    activityLevel: raw.activityLevel ?? "idle",
    signals: raw.signals ?? [],
    updatedAt: raw.updatedAt,
    composerStatus: raw.composerStatus,
    generatingBubbleCount: raw.generatingBubbleCount ?? 0,
    loadingToolCount: raw.loadingToolCount ?? 0,
  };
}

function updateSessionActivityUi() {
  const el = document.getElementById("session-activity");
  if (!el || state.view !== "session") return;
  const next = renderSessionActivityBadge(state.sessionActivity);
  el.outerHTML = next;
}

function stopLivePoll() {
  clearInterval(state._livePollTimer);
  state._livePollTimer = null;
  state.sessionActivity = null;
}

function inboxDigest() {
  const active = state.activeChats.map((c) => `${c.sessionId}:${c.activityLevel}:${c.updatedAt}:${c.liveSummary ?? ""}`).join("|");
  const pinned = state.pinnedSessionIds.join(",");
  return `${active}#${pinned}`;
}

async function refreshHomeLive() {
  if (state.view !== "home" || !state.live) return;
  const prevDigest = inboxDigest();
  try {
    const [activeRes, pinsRes] = await Promise.all([
      liveFetch("/api/atlas/active?withinMs=3600000&limit=40"),
      liveFetch("/api/atlas/pins"),
    ]);
    if (activeRes.ok) {
      const active = await activeRes.json();
      state.activeChats = active.items ?? state.activeChats;
    }
    if (pinsRes.ok) {
      const pins = await pinsRes.json();
      state.pinnedSessionIds = pins.sessionIds ?? state.pinnedSessionIds;
      state.pinnedChatItems = pins.items ?? state.pinnedChatItems;
    }
    if (inboxDigest() !== prevDigest) render();
  } catch {
    // ignore transient poll failures
  }
}

async function refreshSessionLive(sessionId) {
  if (!state.live || !sessionId) return;
  const onSession = state.view === "session" && state.sessionId === sessionId;
  const onExpandedSegment =
    state.view === "segment" && state.sessionId === sessionId && state.expandContext;
  if (!onSession && !onExpandedSegment) return;

  try {
    if (onSession) {
      const [activityRes, activeRes] = await Promise.all([
        liveFetch(`/api/atlas/activity/${sessionId}`),
        liveFetch("/api/atlas/active?withinMs=3600000&limit=40"),
      ]);
      if (activeRes.ok) {
        const active = await activeRes.json();
        state.activeChats = active.items ?? state.activeChats;
      }
      if (activityRes.ok) {
        state.sessionActivity = normalizeActivity(await activityRes.json());
      } else {
        const item = state.activeChats.find((c) => c.sessionId === sessionId);
        state.sessionActivity = normalizeActivity(item);
      }
      const idx = state.activeChats.findIndex((c) => c.sessionId === sessionId);
      if (idx >= 0 && state.sessionActivity) {
        const live = state.activeChats[idx]?.liveSummary;
        state.activeChats[idx] = {
          ...state.activeChats[idx],
          activityLevel: state.sessionActivity.activityLevel,
          signals: state.sessionActivity.signals,
          updatedAt: state.sessionActivity.updatedAt,
          composerStatus: state.sessionActivity.composerStatus,
          generatingBubbleCount: state.sessionActivity.generatingBubbleCount,
          loadingToolCount: state.sessionActivity.loadingToolCount,
          liveSummary: live ?? state.activeChats[idx].liveSummary,
        };
      }
    }

    const spineChanged = await refreshSpine(sessionId);
    if (spineChanged) {
      renderPreservingScroll();
    } else if (onSession) {
      updateWorkingIndicators();
    }
  } catch {
    // ignore transient poll failures
  }
}

function syncLivePoll() {
  stopLivePoll();
  if (!state.live) return;

  const tick = () => {
    if (state.view === "home") refreshHomeLive();
    else if (state.view === "session" && state.sessionId) refreshSessionLive(state.sessionId);
    else if (state.view === "segment" && state.sessionId && state.expandContext) {
      refreshSessionLive(state.sessionId);
    }
  };

  if (state.view === "home") {
    tick();
    state._livePollTimer = setInterval(tick, 5000);
    return;
  }

  if (state.view === "session" && state.sessionId) {
    state.sessionActivity = normalizeActivity(
      state.activeChats.find((c) => c.sessionId === state.sessionId),
    );
    tick();
    state._livePollTimer = setInterval(tick, 2000);
    return;
  }

  if (state.view === "segment" && state.sessionId && state.expandContext) {
    tick();
    state._livePollTimer = setInterval(tick, 2000);
  }
}

function backButton({ nav, label }) {
  return `<button type="button" class="btn back-btn" data-nav="${nav}">← ${esc(label)}</button>`;
}

function sessionBackButton() {
  const theme = state.themeId ? themeById(state.themeId) : null;
  if (state.subthemeKey && theme) {
    const st = subthemeByKey(state.themeId, state.subthemeKey);
    return backButton({ nav: "subtheme", label: st?.label?.slice(0, 40) ?? "Subtopic" });
  }
  return theme
    ? backButton({ nav: "theme", label: theme.label })
    : backButton({ nav: "home", label: "All themes" });
}

function renderPinIcon() {
  return `<svg class="pin-icon lucide lucide-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 17v5"/>
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a3 3 0 0 0-6 0v4.76"/>
  </svg>`;
}

function renderInboxRow(c, { pinned = false, showPin = false } = {}) {
  const summary = inboxRowSummary(c);
  const pinControl = showPin && pinned
    ? `<button type="button" class="pin-icon-btn" data-action="toggle-pin" data-session="${esc(c.sessionId)}" aria-label="Unpin conversation" title="Unpin">${renderPinIcon()}</button>`
    : showPin
      ? `<button type="button" class="btn-compact pin-toggle" data-action="toggle-pin" data-session="${esc(c.sessionId)}" aria-label="Pin conversation">Pin</button>`
      : "";
  return `
    <div class="active-row-item${pinned ? " pinned-row" : ""}" data-session="${esc(c.sessionId)}">
      <div class="active-row-main">
        <div class="active-row-top">
          <h3 class="active-title">${esc(c.title)}</h3>
          <span class="active-meta">${!pinned && c.activityLevel === "active" ? `<span class="active-pulse" aria-hidden="true"></span>` : ""}${esc(c.workspace)} · ${activityLabel(c.activityLevel)}</span>
        </div>
        ${summary ? `<p class="live-summary">${summary}</p>` : ""}
      </div>
      ${pinControl}
    </div>`;
}

function isUntitledChat(c) {
  const title = (c?.title ?? "").trim();
  return !title || title === "(untitled)";
}

function renderActiveZone() {
  const pinnedSet = new Set(state.pinnedSessionIds);
  const chats = state.activeChats.filter((c) => !pinnedSet.has(c.sessionId) && !isUntitledChat(c));
  if (!chats.length) return "";
  return `
    <div class="active-zone">
      <div class="section-label">Active · in flight or recently updated</div>
      <div class="active-list">
        ${chats.map((c) => renderInboxRow(c)).join("")}
      </div>
    </div>`;
}

function renderPinnedZone() {
  const chats = pinnedChats();
  if (!chats.length) return "";
  return `
    <div class="pinned-zone">
      <div class="section-label">Pinned · quick access</div>
      <div class="active-list">
        ${chats.map((c) => renderInboxRow(c, { pinned: true, showPin: true })).join("")}
      </div>
    </div>`;
}

function renderVariantA() {
  if (state.view === "session") {
    const s = sessionById(state.sessionId);
    return `
      <div class="themes-home session-view">
        <div class="session-sticky-head">
          ${sessionBackButton()}
          <div class="session-head">
            <h2>${esc(s?.title ?? "")}</h2>
            <div class="session-head-actions">
              ${renderSessionActivityBadge(state.sessionActivity)}
              <button type="button" class="btn pin-btn${isPinned(state.sessionId) ? " pinned" : ""}" data-action="toggle-pin" data-session="${esc(state.sessionId)}">
                ${isPinned(state.sessionId) ? "Unpin" : "Pin"}
              </button>
            </div>
          </div>
        </div>
        ${renderSessionSpineView(state.sessionId, state.segmentId)}
      </div>`;
  }
  if (state.view === "theme" && state.themeId) {
    const t = themeById(state.themeId);
    const subs = subthemesForTheme(state.themeId);
    const { primary, inline } = splitSubthemes(subs);
    return `
      <div class="themes-home">
        ${backButton({ nav: "home", label: "All themes" })}
        <h2 style="font-size:15px;margin:16px 0 4px;color:${t?.color}">${esc(t?.label ?? "")}</h2>
        <p style="color:var(--muted);font-size:12px;margin-bottom:16px;max-width:640px">${esc(t?.description ?? "")}</p>
        ${primary.length ? `
          <div class="section-label">${primary.length} subtopic${primary.length === 1 ? "" : "s"} · click to see conversations</div>
          <div class="subtheme-card-grid">
            ${primary.map((st) => renderSubthemeCard(st, state.themeId, t?.color ?? "#666")).join("")}
          </div>` : ""}
        ${inline.length ? `
          <div class="subtheme-inline-section">
            <div class="section-label">${inline.length === subs.length ? "Topics" : "Also in this theme"} · single chat</div>
            <div class="subtheme-inline-list">
              ${inline.map((st) => `
                <button type="button" class="subtheme-inline-pill" data-subtheme-open="${esc(st.key)}" data-theme-id="${esc(state.themeId)}">
                  ${esc(st.label)}<span class="subtheme-inline-count">${st.segmentCount} seg</span>
                </button>`).join("")}
            </div>
          </div>` : ""}
      </div>`;
  }
  if (state.view === "subtheme" && state.themeId && state.subthemeKey) {
    const t = themeById(state.themeId);
    const st = subthemeByKey(state.themeId, state.subthemeKey);
    const segs = segmentsForSubtheme(state.themeId, state.subthemeKey);
    const sessionIds = [...new Set(segs.map((s) => s.sessionId))];
    const convos = sessionIds
      .map((id) => sessionById(id))
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return `
      <div class="themes-home">
        ${backButton({ nav: "theme", label: t?.label ?? "Theme" })}
        <h2 style="font-size:14px;margin:16px 0 4px;color:${t?.color}">${esc(st?.label ?? "Subtopic")}</h2>
        <div class="section-label">${convos.length} conversation${convos.length === 1 ? "" : "s"}</div>
        ${convos.map((s) => {
          const sessionSegs = segs.filter((x) => x.sessionId === s.id);
          return `
            <div class="card filed-session" data-session="${s.id}" style="margin-top:8px">
              <h3>${esc(s.title)}</h3>
              <div class="meta">${esc(s.workspace)} · ${fmtDate(s.updatedAt)}</div>
              ${sessionSegs.map((seg) => `
                <div class="seg-item" data-segment="${seg.id}" data-session="${s.id}" style="margin-top:8px">
                  <div class="seg-turn-range">turns ${seg.turnStart}–${seg.turnEnd}</div>
                  ${esc(seg.preview)}
                </div>`).join("")}
            </div>`;
        }).join("")}
      </div>`;
  }
  if (state.view === "segment") {
    const seg = state.SEGMENTS.find((x) => x.id === state.segmentId);
    const s = sessionById(seg?.sessionId);
    if (!seg) return "";
    if (!state.spines[seg.sessionId]) loadSpine(seg.sessionId).then(() => render());
    return `
      <div class="themes-home" style="max-width:720px">
        ${state.subthemeKey
          ? backButton({ nav: "subtheme", label: subthemeByKey(seg.themeId, state.subthemeKey)?.label?.slice(0, 40) ?? "Subtopic" })
          : backButton({ nav: "theme", label: themeById(seg.themeId)?.label ?? "Theme" })}
        <div class="slice-panel" style="margin-top:16px">
          <h4>${esc(s?.title ?? "")} · turns ${seg.turnStart}–${seg.turnEnd}</h4>
          <p style="font-size:13px">${esc(seg.preview)}</p>
          <div class="slice-panel-actions">
            <button type="button" class="btn slice-open-convo" data-action="open-session" data-session="${esc(seg.sessionId)}" data-segment="${esc(seg.id)}">
              Open full conversation →
            </button>
            <button type="button" class="expand" data-action="toggle-context">${state.expandContext ? "Hide context" : "Show surrounding context →"}</button>
          </div>
        </div>
        ${state.expandContext ? `<div style="margin-top:20px"><h3 style="font-size:14px;margin-bottom:12px">Full spine</h3>${renderSpineHtml(seg.sessionId, seg.id)}</div>` : ""}
      </div>`;
  }
  const sortedThemes = [...state.THEMES].sort((a, b) => {
    return themeStats(b.id).sessionCount - themeStats(a.id).sessionCount;
  });
  return `
    ${renderActiveZone()}
    ${renderPinnedZone()}
    <div class="themes-home">
      <div class="section-label themes-label">Themes · click to see subtopics</div>
      <div class="theme-card-grid">
        ${sortedThemes.map((t) => {
          const stats = themeStats(t.id);
          if (stats.sessionCount === 0) return "";
          return `
            <div class="theme-card" data-theme-open="${t.id}" style="--theme-color:${t.color}">
              <div class="theme-card-accent"></div>
              <div class="theme-card-body">
                <div class="theme-card-head">
                  <h3>${esc(t.label)}</h3>
                  <span class="theme-counts">${stats.sessionCount} chat${stats.sessionCount === 1 ? "" : "s"} · ${stats.subthemeCount} topics</span>
                </div>
                <div class="theme-card-summary">${esc(t.description)}</div>
              </div>
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

function renderVariantB() {
  if (state.view === "session") {
    const s = sessionById(state.sessionId);
    return `<div style="padding:20px"><h2 style="margin-bottom:16px">${esc(s?.title ?? "")}</h2>${renderSpineHtml(state.sessionId, state._searchHighlightTurn != null ? null : state.segmentId)}</div>`;
  }
  const rows = [...state.SESSIONS]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((s) => {
      const primary = segmentsForSession(s.id)[0];
      const color = themeById(primary?.themeId)?.color || "#666";
      return `
        <div class="tl-row">
          <div class="tl-dot" style="background:${color}"></div>
          <div class="card tl-card" data-session="${s.id}">
            <h3>${esc(s.title)}</h3>
            <div class="meta">${fmtDate(s.updatedAt)} · ${esc(s.workspace)}</div>
            <div>${segmentsForSession(s.id).map((seg) => chip(seg.themeId)).join("")}</div>
          </div>
        </div>`;
    });
  return `<div class="variant-b timeline">${rows.join("")}</div>`;
}

function renderVariantC() {
  const t = themeById(state.cThemeId);
  const segs = segmentsForTheme(state.cThemeId);
  let main = "";
  if (state.view === "session") {
    main = `<h2 style="margin-bottom:16px">${esc(sessionById(state.sessionId)?.title ?? "")}</h2>${renderSpineHtml(state.sessionId, state._searchHighlightTurn != null ? null : state.segmentId)}`;
  } else if (t) {
    main = `
      <h2 style="font-size:15px;margin-bottom:4px;color:${t.color}">${esc(t.label)}</h2>
      <p style="color:var(--muted);font-size:12px;margin-bottom:16px">${esc(t.description)}</p>
      ${segs.map((seg) => segmentRow(seg)).join("")}`;
  }
  return `
    <div class="variant-c split">
      <div class="sidebar">
        <div style="font-size:11px;color:var(--muted);padding:8px 12px;text-transform:uppercase">Themes</div>
        ${state.THEMES.map((th) => `
          <button class="theme-btn ${th.id === state.cThemeId ? "active" : ""}" data-theme="${th.id}" style="border-left:3px solid ${th.color}">
            ${esc(th.label)}
          </button>`).join("")}
        <div style="margin-top:16px;font-size:11px;color:var(--muted);padding:8px 12px;text-transform:uppercase">All chats</div>
        ${state.SESSIONS.map((s) => `<button class="theme-btn" data-session-nav="${s.id}">${esc(s.title)}</button>`).join("")}
      </div>
      <div class="main">${main}</div>
    </div>`;
}

function updateCrumb() {
  const parts = [`<a data-nav="home">Atlas</a>`];
  if (state.view === "theme" && state.themeId) {
    parts.push(esc(themeById(state.themeId)?.label || "Theme"));
  } else if (state.view === "subtheme" && state.themeId && state.subthemeKey) {
    parts.push(esc(themeById(state.themeId)?.label || "Theme"));
    parts.push(esc(subthemeByKey(state.themeId, state.subthemeKey)?.label || "Subtopic"));
  } else if (state.view === "segment" && state.segmentId) {
    const seg = state.SEGMENTS.find((x) => x.id === state.segmentId);
    parts.push(themeById(seg?.themeId)?.label || "Theme");
    if (seg) parts.push(esc(subthemeLabel(seg)));
    parts.push("slice");
  } else if (state.view === "session" && state.sessionId) {
    if (state.themeId) parts.push(esc(themeById(state.themeId)?.label || "Theme"));
    if (state.subthemeKey) parts.push(esc(subthemeByKey(state.themeId, state.subthemeKey)?.label || "Subtopic"));
    parts.push(esc(sessionById(state.sessionId)?.title || "Chat"));
  }
  if (crumb) crumb.innerHTML = parts.join(' <span style="color:var(--muted)">/</span> ');
}

function updateStatus() {
  if (!statusEl) return;
  if (state.loading) {
    statusEl.textContent = "Loading…";
    return;
  }
  if (!state.live) {
    statusEl.textContent = `sample data (${state.error ?? "offline"})`;
    return;
  }
  const parts = [`${state.SESSIONS.length} chats`, `${state.THEMES.length} themes`];
  if ((state.view === "session" || state.view === "segment") && state.sessionId) {
    const shown = spineChunkGroups(state.sessionId).length;
    if (shown) parts.push(`${shown} turns shown`);
  }
  statusEl.textContent = parts.join(" · ");
}

function syncChromeHeight() {
  const chrome = document.querySelector(".atlas-top-chrome");
  const sessionHead = root.querySelector(".session-sticky-head");
  const chromeH = chrome?.offsetHeight ?? 0;
  const sessionHeadH = sessionHead?.offsetHeight ?? 0;
  document.documentElement.style.setProperty("--atlas-chrome-h", `${chromeH}px`);
  document.documentElement.style.setProperty("--session-head-h", `${sessionHeadH}px`);
}

function render() {
  updateCrumb();
  updateStatus();
  if (state.loading) {
    root.innerHTML = `<p style="padding:24px;color:var(--muted)">Loading conversations…</p>`;
    syncChromeHeight();
    return;
  }
  const cls = state.variant === "A" ? "variant-a" : state.variant === "B" ? "variant-b" : "variant-c";
  let body = "";
  if (state.variant === "A") body = renderVariantA();
  else if (state.variant === "B") body = renderVariantB();
  else body = renderVariantC();
  root.className = cls;
  root.innerHTML = body;
  bindEvents();
  syncChromeHeight();
}

function bindEvents() {
  root.querySelectorAll("[data-theme-open]").forEach((el) => {
    el.onclick = () => navigate("theme", { themeId: el.dataset.themeOpen });
  });
  root.querySelectorAll("[data-subtheme-open]").forEach((el) => {
    el.onclick = () => navigate("subtheme", {
      themeId: el.dataset.themeId || state.themeId,
      subthemeKey: el.dataset.subthemeOpen,
      sessionId: null,
      segmentId: null,
    });
  });
  root.querySelectorAll("[data-segment]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      navigate("segment", {
        segmentId: el.dataset.segment,
        sessionId: el.dataset.session,
        themeId: state.themeId ?? state.SEGMENTS.find((x) => x.id === el.dataset.segment)?.themeId,
        subthemeKey: state.subthemeKey,
      });
    };
  });
  root.querySelectorAll("[data-session]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("[data-segment]")) return;
      if (e.target.closest("[data-action=toggle-pin]")) return;
      const sessionId = el.dataset.session;
      const firstSeg = segmentsForSession(sessionId)[0];
      navigate("session", {
        sessionId,
        themeId: state.themeId ?? firstSeg?.themeId ?? null,
        subthemeKey: state.subthemeKey,
      });
    };
  });
  root.querySelectorAll("[data-theme]").forEach((el) => {
    el.onclick = () => navigate("theme", { themeId: el.dataset.theme });
  });
  root.querySelectorAll("[data-session-nav]").forEach((el) => {
    el.onclick = () => navigate("session", { sessionId: el.dataset.sessionNav });
  });
  root.querySelectorAll("[data-action=toggle-context]").forEach((el) => {
    el.onclick = () => {
      state.expandContext = !state.expandContext;
      syncUrl({ replace: true });
      render();
      syncLivePoll();
    };
  });
  root.querySelectorAll("[data-action=open-session]").forEach((el) => {
    el.onclick = () => {
      const seg = state.SEGMENTS.find((x) => x.id === el.dataset.segment);
      navigate("session", {
        sessionId: el.dataset.session,
        segmentId: el.dataset.segment || null,
        themeId: state.themeId ?? seg?.themeId ?? null,
        subthemeKey: state.subthemeKey,
      });
    };
  });
  root.querySelectorAll("[data-action=toggle-pin]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      togglePin(el.dataset.session);
    };
  });
  root.querySelectorAll("[data-nav]").forEach((el) => {
    el.onclick = () => {
      const nav = el.dataset.nav;
      if (nav === "home") navigate("home", { themeId: null, subthemeKey: null, sessionId: null, segmentId: null });
      else if (nav === "theme" && state.themeId) navigate("theme", { themeId: state.themeId, subthemeKey: null, sessionId: null, segmentId: null });
      else if (nav === "subtheme" && state.themeId && state.subthemeKey) navigate("subtheme", { themeId: state.themeId, subthemeKey: state.subthemeKey, sessionId: null, segmentId: null });
    };
  });
  if (crumb) {
    crumb.querySelectorAll("[data-nav]").forEach((el) => {
      el.onclick = () => navigate("home", { themeId: null, subthemeKey: null, sessionId: null, segmentId: null });
    });
  }
  bindSpineMinimap();
  if (state._searchHighlightTurn != null) {
    markSearchTurn(state._searchHighlightTurn, { flash: false });
  }
}

function buildSearchRows() {
  const rows = [];
  for (const s of state.SESSIONS) {
    rows.push({
      id: `title-${s.id}`,
      sessionId: s.id,
      scope: "title",
      text: s.title || "",
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
    if (s.workspace) {
      rows.push({
        id: `ws-${s.id}`,
        sessionId: s.id,
        scope: "workspace",
        text: s.workspace,
        segmentId: null,
        turnStart: null,
        turnEnd: null,
      });
    }
  }
  for (const seg of state.SEGMENTS) {
    const label = [seg.preview, seg.groupLabel, seg.subtheme].filter(Boolean).join(" ");
    rows.push({
      id: `seg-${seg.id}`,
      sessionId: seg.sessionId,
      scope: "segment",
      text: `${label} ${sessionById(seg.sessionId)?.title || ""}`,
      segmentId: seg.id,
      turnStart: seg.turnStart,
      turnEnd: seg.turnEnd,
    });
  }
  const spines = { ...(!state.live ? state.SPINE : {}), ...state.spines };
  for (const [sessionId, spine] of Object.entries(spines)) {
    if (!spine?.turns) continue;
    for (const turn of spine.turns) {
      if (!turn.preview) continue;
      rows.push({
        id: `turn-${sessionId}-${turn.n}-${turn.role}`,
        sessionId,
        scope: turn.role,
        text: turn.preview,
        segmentId: turn.segmentId ?? null,
        turnStart: turn.n,
        turnEnd: turn.n,
      });
    }
  }
  return rows;
}

function runSearchLocal(query) {
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], elapsedMs: 0, scanned: 0 };
  const rows = buildSearchRows();
  const t0 = performance.now();
  const hits = [];
  for (const row of rows) {
    const hay = row.text.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 48);
    const end = Math.min(row.text.length, idx + q.length + 64);
    let snippet = row.text.slice(start, end);
    if (start > 0) snippet = `…${snippet}`;
    if (end < row.text.length) snippet = `${snippet}…`;
    hits.push({
      ...row,
      snippet,
      matchAt: idx,
      rank: row.scope === "title" ? 3 : row.scope === "user" || row.scope === "segment" ? 2 : 1,
    });
  }
  hits.sort((a, b) => b.rank - a.rank || a.matchAt - b.matchAt);
  return {
    hits: hits.slice(0, 40),
    elapsedMs: Math.max(1, Math.round(performance.now() - t0)),
    scanned: rows.length,
    sessions: new Set(hits.map((h) => h.sessionId)).size,
  };
}

function openOmni(prefill = "") {
  if (omni.closing) return;
  omni.open = true;
  omni.query = prefill;
  omni.active = 0;
  omni.hits = [];
  omni.elapsedMs = 0;
  omni.scanned = 0;
  omni.searching = false;
  document.body.classList.add("omni-open");
  if (omni.mounted) {
    const input = omniEl.querySelector(".omni-input");
    if (input) input.value = omni.query;
    refreshOmniBody();
    input?.focus();
    if (prefill) input?.select();
    void applyOmniQuery(omni.query);
    return;
  }
  renderOmni({ entering: true });
  const input = omniEl.querySelector(".omni-input");
  input?.focus();
  if (prefill) input?.select();
  void applyOmniQuery(omni.query);
}

function closeOmni() {
  if (!omni.open || omni.closing) return;
  omni.closing = true;
  clearTimeout(omni.searchTimer);
  omniEl.classList.remove("omni-entering");
  omniEl.classList.add("omni-closing");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    omni.open = false;
    omni.closing = false;
    omni.mounted = false;
    omni.query = "";
    omni.hits = [];
    omni.active = 0;
    omniEl.classList.add("hidden");
    omniEl.classList.remove("omni-closing", "omni-entering");
    omniEl.setAttribute("aria-hidden", "true");
    omniEl.innerHTML = "";
    document.body.classList.remove("omni-open");
  };
  omniEl.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, 180);
}

function syncOmniActive() {
  omniEl.querySelectorAll(".search-hit").forEach((hit, i) => {
    hit.classList.toggle("active", i === omni.active);
    hit.setAttribute("aria-selected", String(i === omni.active));
  });
  omniEl.querySelector(`.search-hit[data-hit="${omni.active}"]`)?.scrollIntoView({ block: "nearest" });
}

function setOmniSearching(next) {
  omni.searching = next;
}

function renderOmniBody() {
  const q = omni.query.trim();
  if (!q) {
    return `
      <div class="omni-meta">Try a phrase</div>
      <div class="search-examples">
        ${SEARCH_EXAMPLES.map((ex) => `<button type="button" class="search-example" data-example="${esc(ex)}">${esc(ex)}</button>`).join("")}
      </div>
      <p class="search-note">Search titles, segments, and message text. Recent chats are scanned live; older history uses Cursor’s FTS index.</p>
    `;
  }
  if (omni.searching) {
    return `
      <div class="search-loader" role="status" aria-live="polite">
        <span class="search-spinner" aria-hidden="true"></span>
        <span class="search-loader-text">Searching conversations…</span>
      </div>
    `;
  }
  if (!omni.hits.length) {
    return `<p class="search-empty">No matches for “${esc(q)}”</p>`;
  }
  return `
    <div class="omni-meta">${omni.hits.length} hit${omni.hits.length === 1 ? "" : "s"} · ${omni.elapsedMs}ms · ${omni.scanned} rows</div>
    <div class="search-hits" role="listbox">
      ${omni.hits.map((hit, i) => {
        const s = sessionById(hit.sessionId);
        const meta = [
          hit.turnStart != null ? `turn ${hit.turnStart}${hit.turnEnd != null && hit.turnEnd !== hit.turnStart ? `–${hit.turnEnd}` : ""}` : null,
          s?.workspace,
        ].filter(Boolean).join(" · ");
        return `
          <button type="button" class="search-hit${i === omni.active ? " active" : ""}" role="option" data-hit="${i}" aria-selected="${i === omni.active}">
            <div class="search-hit-top">
              <span class="search-hit-title">${esc(s?.title || hit.sessionId)}</span>
              ${meta ? `<span class="search-hit-meta">${esc(meta)}</span>` : ""}
            </div>
            <div class="search-hit-snippet">${highlightMatch(hit.snippet, q)}</div>
            <div class="search-scope">${esc(hit.scope)}</div>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function bindOmniBody() {
  omniEl.querySelectorAll("[data-example]").forEach((el) => {
    el.onclick = () => {
      omni.query = el.dataset.example || "";
      const input = omniEl.querySelector(".omni-input");
      if (input) input.value = omni.query;
      void applyOmniQuery(omni.query);
      input?.focus();
    };
  });
  omniEl.querySelectorAll("[data-hit]").forEach((el) => {
    el.onclick = () => selectOmniHit(Number(el.dataset.hit));
    el.onmouseenter = () => {
      omni.active = Number(el.dataset.hit);
      syncOmniActive();
    };
  });
}

function refreshOmniBody() {
  const body = omniEl.querySelector(".omni-body");
  if (!body) return;
  // Keep an in-flight loader mounted so the spinner doesn't restart on each keystroke.
  if (omni.searching && body.querySelector(".search-loader")) return;
  body.innerHTML = renderOmniBody();
  bindOmniBody();
}

async function applyOmniQuery(query) {
  omni.query = query;
  const gen = ++omni.searchGen;
  const q = query.trim();
  if (!q) {
    omni.hits = [];
    omni.elapsedMs = 0;
    omni.scanned = 0;
    omni.active = 0;
    setOmniSearching(false);
    refreshOmniBody();
    return;
  }

  setOmniSearching(true);
  refreshOmniBody();

  if (state.live && q) {
    try {
      const res = await liveFetch(`/api/atlas/search?q=${encodeURIComponent(q)}`);
      if (gen !== omni.searchGen) return;
      if (res.ok) {
        const data = await res.json();
        omni.hits = data.hits ?? [];
        omni.elapsedMs = data.elapsedMs ?? 0;
        omni.scanned = data.scanned ?? 0;
        omni.active = 0;
        setOmniSearching(false);
        refreshOmniBody();
        return;
      }
    } catch {
      if (gen !== omni.searchGen) return;
    }
  }
  const result = runSearchLocal(query);
  if (gen !== omni.searchGen) return;
  omni.hits = result.hits;
  omni.elapsedMs = result.elapsedMs;
  omni.scanned = result.scanned;
  omni.active = 0;
  setOmniSearching(false);
  refreshOmniBody();
}

function renderOmni({ entering = false } = {}) {
  if (!omni.open) return;
  omni.mounted = true;
  omniEl.classList.remove("hidden", "omni-closing");
  omniEl.classList.toggle("omni-entering", entering);
  omniEl.setAttribute("aria-hidden", "false");
  omniEl.innerHTML = `
    <div class="omni-backdrop" data-omni-close></div>
    <div class="omni-modal" role="dialog" aria-label="Search conversations">
      <div class="omni-input-row">
        <span class="omni-icon" aria-hidden="true">⌕</span>
        <input class="omni-input" type="text" placeholder="Search conversations…" value="${esc(omni.query)}" autocomplete="off" spellcheck="false" />
        <kbd class="omni-esc">esc</kbd>
      </div>
      <div class="omni-body">${renderOmniBody()}</div>
    </div>
  `;

  if (entering) {
    const clearEntering = () => omniEl.classList.remove("omni-entering");
    omniEl.addEventListener("animationend", clearEntering, { once: true });
    setTimeout(clearEntering, 180);
  }

  const input = omniEl.querySelector(".omni-input");
  input?.addEventListener("input", (e) => {
    const value = e.target.value;
    omni.query = value;
    clearTimeout(omni.searchTimer);
    if (value.trim()) {
      setOmniSearching(true);
      refreshOmniBody();
    } else {
      setOmniSearching(false);
      refreshOmniBody();
    }
    omni.searchTimer = setTimeout(() => {
      void applyOmniQuery(value);
    }, 200);
  });

  omniEl.querySelectorAll("[data-omni-close]").forEach((el) => {
    el.onclick = () => closeOmni();
  });
  bindOmniBody();
}

function focusSessionTurn(sessionId, turn, { themeId = null, fromSearch = false } = {}) {
  if (fromSearch && turn != null) {
    state._pendingScrollTurn = turn;
    state._searchHighlightTurn = turn;
    state.highlightTurn = null;
    state.segmentId = null;
  } else if (turn != null) {
    state._pendingScrollTurn = turn;
    state.highlightTurn = turn;
    state._searchHighlightTurn = null;
  } else {
    state._pendingScrollTurn = null;
    state.highlightTurn = null;
    state._searchHighlightTurn = null;
  }

  const sameSession = state.view === "session" && state.sessionId === sessionId;
  if (sameSession) {
    if (themeId) state.themeId = themeId;
    render();
    return;
  }

  navigate("session", {
    sessionId,
    themeId: themeId ?? segmentsForSession(sessionId)[0]?.themeId ?? null,
    subthemeKey: null,
    segmentId: fromSearch ? null : state.segmentId,
    highlightTurn: fromSearch ? null : turn,
  });
}

function selectOmniHit(index) {
  const hit = omni.hits[index];
  if (!hit) return;
  closeOmni();

  const turn = hit.turnStart ?? null;
  const seg =
    (hit.segmentId ? state.SEGMENTS.find((x) => x.id === hit.segmentId) : null) ??
    (turn != null
      ? segmentsForSession(hit.sessionId).find((s) => turn >= s.turnStart && turn <= s.turnEnd)
      : null);

  if (seg && turn == null) {
    navigate("segment", {
      segmentId: seg.id,
      sessionId: seg.sessionId,
      themeId: seg.themeId,
      subthemeKey: null,
    });
    return;
  }

  focusSessionTurn(hit.sessionId, turn, {
    themeId: seg?.themeId ?? null,
    fromSearch: turn != null,
  });
}

searchTrigger?.addEventListener("click", () => openOmni());

document.addEventListener("keydown", (e) => {
  const metaK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
  if (metaK) {
    e.preventDefault();
    if (omni.open) closeOmni();
    else openOmni();
    return;
  }
  if (!omni.open || omni.closing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeOmni();
    return;
  }
  if (omni.searchTimer && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    clearTimeout(omni.searchTimer);
    omni.searchTimer = null;
    void applyOmniQuery(omni.query);
  }
  if (e.key === "ArrowDown" && omni.hits.length) {
    e.preventDefault();
    omni.active = (omni.active + 1) % omni.hits.length;
    syncOmniActive();
    return;
  }
  if (e.key === "ArrowUp" && omni.hits.length) {
    e.preventDefault();
    omni.active = (omni.active - 1 + omni.hits.length) % omni.hits.length;
    syncOmniActive();
    return;
  }
  if (e.key === "Enter" && omni.hits.length) {
    e.preventDefault();
    selectOmniHit(omni.active);
  }
});

window.addEventListener("popstate", () => {
  if (state.loading) return;
  const route = history.state?.atlas ?? parseRouteFromLocation();
  applyRoute(route, { replaceUrl: true });
  render();
});

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

loadAtlas();
window.addEventListener("resize", syncChromeHeight, { passive: true });
