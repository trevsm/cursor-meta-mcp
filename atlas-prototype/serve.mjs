#!/usr/bin/env node
/** PROTOTYPE — static file server for atlas-prototype */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 3847;

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

createServer(async (req, res) => {
  const path = req.url?.split("?")[0] || "/";
  const file = path === "/" ? "index.html" : path.replace(/^\//, "");
  try {
    const body = await readFile(join(dir, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] || "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => {
  console.log(`Conversation Atlas PROTOTYPE → http://localhost:${port}`);
  console.log(`Variants: ?variant=A (theme columns) | B (timeline) | C (split)`);
});
