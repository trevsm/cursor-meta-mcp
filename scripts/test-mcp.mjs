#!/usr/bin/env node
/**
 * End-to-end smoke test for cursor-meta-mcp tools (history + optional SDK).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "dist/index.js");

async function callTool(name, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-mcp", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      },
    ];

    child.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    child.stdin.end();

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Server exited ${code}: ${stderr}`));
        return;
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      const response = JSON.parse(lines.find((line) => line.includes('"id":2')) ?? lines.at(-1));
      resolve({ response, stderr });
    });
  });
}

const expectedTools = [
  "meta_abort_chat",
  "meta_cancel_run",
  "meta_consciousness_pulse",
  "meta_continue_from_chat",
  "meta_create_chat",
  "meta_export_chat",
  "meta_follow_up",
  "meta_get_chat_activity",
  "meta_get_run",
  "meta_intercept_agent",
  "meta_intercept_chat",
  "meta_list_active_chats",
  "meta_list_active_runs",
  "meta_list_agent_runs",
  "meta_list_chats",
  "meta_list_local_agents",
  "meta_orchestrate_loop",
  "meta_orchestrate_pulse",
  "meta_relentless_loop",
  "meta_search_chats",
  "meta_sentiment_analysis",
  "meta_send_to_chat",
  "meta_show_chat",
  "meta_spawn_local_agent",
  "meta_watch_chat",
  "meta_whoami",
];

async function listTools() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-mcp", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];

    child.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    child.stdin.end();

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Server exited ${code}: ${stderr}`));
        return;
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      const response = JSON.parse(lines.find((line) => line.includes('"id":2')) ?? lines.at(-1));
      resolve(response.result?.tools?.map((tool) => tool.name).sort() ?? []);
    });
  });
}

const tests = [
  ["meta_list_chats", { limit: 3 }],
  ["meta_search_chats", { query: "MCP", limit: 2 }],
  ["meta_show_chat", { sessionIndex: 1 }],
  ["meta_sentiment_analysis", { topMessages: 3, topSessions: 2 }],
  ["meta_consciousness_pulse", { limit: 5 }],
  ["meta_whoami", {}],
];

if (process.env.CURSOR_API_KEY) {
  tests.push([
    "meta_spawn_local_agent",
    {
      cwd: root,
      prompt: "Reply with exactly: META_SPAWN_OK",
      mode: "ask",
    },
  ]);
}

console.log("cursor-meta-mcp smoke test");
console.log("CURSOR_API_KEY:", process.env.CURSOR_API_KEY ? "set" : "NOT SET");
console.log("---");

try {
  const tools = await listTools();
  const missing = expectedTools.filter((name) => !tools.includes(name));
  const extra = tools.filter((name) => !expectedTools.includes(name));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`[OK] tools/list (${tools.length} tools)`);
  } else {
    console.log("[ERROR] tools/list mismatch");
    if (missing.length > 0) console.log("  missing:", missing.join(", "));
    if (extra.length > 0) console.log("  extra:", extra.join(", "));
  }
  console.log("---");
} catch (error) {
  console.log(`[FAIL] tools/list: ${error.message}`);
  console.log("---");
}

for (const [name, args] of tests) {
  try {
    const { response } = await callTool(name, args);
    const text = response.result?.content?.[0]?.text ?? JSON.stringify(response.result);
    const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    const status = response.result?.isError ? "ERROR" : "OK";
    console.log(`[${status}] ${name}`);
    console.log(preview);
    console.log("---");
  } catch (error) {
    console.log(`[FAIL] ${name}: ${error.message}`);
    console.log("---");
  }
}
