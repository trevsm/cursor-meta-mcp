import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { readAtlasIndex, buildHeuristicIndex, normalizeAtlasIndex } from "./atlas-index.js";
import { archiveSessionBubbles, startBubbleArchiveWatcher } from "./atlas-bubble-archive.js";
import { searchAtlas } from "./atlas-search.js";
import { loadCursorPinnedComposerIds } from "./cursor-pinned-composers.js";
import { readAtlasPins, resolvePinnedChatItems, writeAtlasPins } from "./atlas-pins.js";
import { loadAtlasSpine, liveSummariesForSessions } from "./atlas-spine.js";
import { getChatActivity, listActiveChats } from "./chat-activity.js";

const prototypeDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "atlas-prototype");
const port = Number(process.env.PORT) || 3847;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

const NO_STORE = { "Cache-Control": "no-store" };

async function sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  res.writeHead(status, { "Content-Type": "application/json", ...NO_STORE });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (pathname === "/api/atlas/health") {
    await sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/atlas" && req.method === "GET") {
    let index = await readAtlasIndex();
    if (!index) {
      index = normalizeAtlasIndex(await buildHeuristicIndex({ limit: Number(searchParams.get("limit") ?? 25) }));
    }
    await sendJson(res, 200, index);
    return true;
  }

  if (pathname === "/api/atlas/active" && req.method === "GET") {
    const limit = Number(searchParams.get("limit") ?? 12);
    const withinMs = Number(searchParams.get("withinMs") ?? 30 * 60 * 1000);
    const index = await readAtlasIndex();
    const includeSessionIds = index?.sessions.map((s) => s.id) ?? [];
    const activities = listActiveChats({ limit, withinMs, includeSessionIds, maxScan: Math.max(limit * 6, 60) });
    const liveSummaries = liveSummariesForSessions(activities.map((a) => a.sessionId));
    const sessionsById = new Map(index?.sessions.map((s) => [s.id, s]) ?? []);
    const bestSeg = new Map<string, { turnEnd: number; preview: string }>();
    for (const seg of index?.segments ?? []) {
      const cur = bestSeg.get(seg.sessionId);
      if (!cur || seg.turnEnd >= cur.turnEnd) bestSeg.set(seg.sessionId, { turnEnd: seg.turnEnd, preview: seg.preview });
    }
    const items = activities
      .map((a) => {
        const indexed = sessionsById.get(a.sessionId);
        const seg = bestSeg.get(a.sessionId);
        const fallback = a.signals.length ? a.signals.join(" · ") : "Recently updated";
        const live = liveSummaries.get(a.sessionId);
        const liveSummary =
          a.activityLevel === "active" && a.signals.length
            ? fallback
            : live ?? seg?.preview ?? fallback;
        return {
          sessionId: a.sessionId,
          title: indexed?.title ?? a.title,
          workspace: indexed?.workspace ?? a.workspace,
          updatedAt: a.updatedAt,
          activityLevel: a.activityLevel,
          signals: a.signals,
          composerStatus: a.composerStatus,
          generatingBubbleCount: a.generatingBubbleCount,
          loadingToolCount: a.loadingToolCount,
          liveSummary,
        };
      })
      .filter((item) => {
        const title = item.title?.trim();
        return Boolean(title) && title !== "(untitled)";
      });
    await sendJson(res, 200, { items, generatedAt: new Date().toISOString() });
    return true;
  }

  if (pathname === "/api/atlas/search" && req.method === "GET") {
    const query = searchParams.get("q") ?? "";
    let index = await readAtlasIndex();
    if (!index) {
      index = normalizeAtlasIndex(await buildHeuristicIndex({ limit: Number(searchParams.get("limit") ?? 25) }));
    }
    const result = searchAtlas({ query, index, limit: Number(searchParams.get("limit") ?? 40) });
    await sendJson(res, 200, result);
    return true;
  }

  if (pathname === "/api/atlas/reindex" && req.method === "POST") {
    const limit = Number(searchParams.get("limit") ?? 25);
    const index = await buildHeuristicIndex({ limit });
    await sendJson(res, 200, index);
    return true;
  }

  if (pathname === "/api/atlas/pins" && req.method === "GET") {
    const pins = await readAtlasPins();
    const cursorIds = loadCursorPinnedComposerIds();
    const items = resolvePinnedChatItems(pins.visibleSessionIds, cursorIds);
    await sendJson(res, 200, {
      sessionIds: pins.visibleSessionIds,
      items,
      updatedAt: pins.updatedAt,
    });
    return true;
  }

  if (pathname === "/api/atlas/pins" && req.method === "PUT") {
    const body = (await readJsonBody(req)) as { sessionIds?: string[] };
    const pins = await writeAtlasPins(Array.isArray(body.sessionIds) ? body.sessionIds : []);
    const cursorIds = loadCursorPinnedComposerIds();
    const items = resolvePinnedChatItems(pins.visibleSessionIds, cursorIds);
    await sendJson(res, 200, {
      sessionIds: pins.visibleSessionIds,
      items,
      updatedAt: pins.updatedAt,
    });
    return true;
  }

  const spineMatch = pathname.match(/^\/api\/atlas\/spine\/([0-9a-f-]+)$/i);
  if (spineMatch && req.method === "GET") {
    const sessionId = spineMatch[1]!;
    try {
      const spine = loadAtlasSpine(sessionId);
      await sendJson(res, 200, spine);
    } catch (err) {
      await sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const activityMatch = pathname.match(/^\/api\/atlas\/activity\/([0-9a-f-]+)$/i);
  if (activityMatch && req.method === "GET") {
    const sessionId = activityMatch[1]!;
    try {
      const activity = getChatActivity(sessionId);
      await sendJson(res, 200, activity);
    } catch (err) {
      await sendJson(res, 404, { error: String(err) });
    }
    return true;
  }

  return false;
}

async function serveStatic(res: ServerResponse, file: string): Promise<void> {
  const body = await readFile(join(prototypeDir, file));
  const cache =
    file.endsWith(".html") || file.endsWith(".js") || file.endsWith(".css")
      ? { "Cache-Control": "no-cache" }
      : NO_STORE;
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "text/plain", ...cache });
  res.end(body);
}

export function startAtlasServer(): void {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const pathname = url.pathname;

      if (await handleApi(req, res, pathname, url.searchParams)) return;

      const file = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
      if (file.includes("..")) {
        res.writeHead(400).end("Bad path");
        return;
      }
      await serveStatic(res, file);
    } catch {
      res.writeHead(404).end("Not found");
    }
  }).listen(port, () => {
    console.error(`Conversation Atlas → http://localhost:${port}`);
    console.error(`API: GET /api/atlas · GET /api/atlas/pins · GET /api/atlas/search · GET /api/atlas/spine/:sessionId`);
    if (process.env.ATLAS_ARCHIVE_DISABLE !== "1" && process.env.ATLAS_ARCHIVE_IN_SERVER !== "0") {
      startBubbleArchiveWatcher();
    }
  });
}

if (process.argv[1]?.endsWith("atlas-server.ts") || process.argv[1]?.endsWith("atlas-server.js")) {
  startAtlasServer();
}
