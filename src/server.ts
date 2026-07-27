import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AgentRunResult, LocalAgentService, RunHooks } from "./cursor-local.js";
import { describeError } from "./errors.js";
import {
  exportChat,
  historyErrorMessage,
  listChats,
  loadSessionSummary,
  loadSessionSummaryById,
  searchChats,
  showChat,
} from "./history.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ServerInfo {
  name: string;
  version: string;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: "cursor-meta-mcp",
  version: "0.1.0",
};

function runHooksFrom(extra: ToolExtra): RunHooks {
  const signal = extra.signal;
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return { signal };
  }
  let progress = 0;
  return {
    signal,
    onProgress: (event) => {
      progress += 1;
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            message: `[${event.type}] ${event.message}`,
          },
        })
        .catch(() => {});
    },
  };
}

function jsonResult(value: unknown): CallToolResult {
  const structured = JSON.parse(JSON.stringify(value));
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent:
      typeof structured === "object" && structured !== null && !Array.isArray(structured)
        ? structured
        : { value: structured },
  };
}

function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${describeError(error)}` }],
    isError: true,
  };
}

function formatRun(run: AgentRunResult): CallToolResult {
  const summary =
    `Local agent ${run.agentId} finished with status "${run.status}".\n` +
    `Run: ${run.runId}\n\n` +
    `${run.result || "(no final assistant text)"}`;
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: run as unknown as Record<string, unknown>,
    isError: run.status === "error",
  };
}

const modeSchema = z
  .enum(["agent", "plan", "ask"])
  .optional()
  .describe('"agent" implements changes; "plan" explores first; "ask" is read-only Q&A.');

const settingSourceSchema = z.enum(["project", "user", "team", "mdm", "plugins", "all"]);

const stdioMcpServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const remoteMcpServerSchema = z
  .object({
    type: z.enum(["http", "sse"]).optional(),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const mcpServerSchema = z.union([stdioMcpServerSchema, remoteMcpServerSchema]);

const localAgentInputSchema = {
  prompt: z.string().min(1).describe("Instruction for the local Cursor agent."),
  cwd: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Absolute path(s) the agent should work in."),
  model: z.string().optional().describe('Model id, e.g. "composer-2.5".'),
  mode: modeSchema,
  settingSources: z.array(settingSourceSchema).optional(),
  mcpServers: z.record(mcpServerSchema).optional(),
  sandboxOptions: z.object({ enabled: z.boolean() }).strict().optional(),
  autoReview: z.boolean().optional(),
  name: z.string().min(1).optional(),
};

export function createServer(
  service: LocalAgentService,
  info: ServerInfo = DEFAULT_SERVER_INFO,
): McpServer {
  const server = new McpServer(info);

  server.registerTool(
    "meta_list_chats",
    {
      title: "List Cursor chat sessions",
      description:
        "List past Cursor IDE chat sessions from local SQLite storage. Returns 1-based sessionIndex values for meta_show_chat and meta_export_chat.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        workspace: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await listChats(args));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_show_chat",
    {
      title: "Show Cursor chat session",
      description:
        "Load full content of a past Cursor chat by 1-based sessionIndex or by sessionId (UUID).",
      inputSchema: {
        sessionIndex: z.number().int().min(1).optional(),
        sessionId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIndex, sessionId }) => {
      try {
        if (!sessionIndex && !sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        return jsonResult(await showChat({ sessionIndex, sessionId }));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_search_chats",
    {
      title: "Search Cursor chat history",
      description: "Full-text search across local Cursor chat history.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        context: z.number().int().min(0).max(20).optional(),
        workspace: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await searchChats(args));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_export_chat",
    {
      title: "Export Cursor chat session",
      description: "Export a past chat as markdown or json using 1-based sessionIndex.",
      inputSchema: {
        sessionIndex: z.number().int().min(1),
        format: z.enum(["markdown", "json"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIndex, format }) => {
      try {
        return jsonResult(await exportChat({ sessionIndex, format }));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_spawn_local_agent",
    {
      title: "Spawn local Cursor agent",
      description:
        "Create and run a local Cursor SDK agent on this machine. Returns agentId and runId for follow-ups. No cloud agents.",
      inputSchema: localAgentInputSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params, extra) => {
      try {
        return formatRun(await service.runLocalAgent(params, runHooksFrom(extra)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_continue_from_chat",
    {
      title: "Continue work from past chat",
      description:
        "Load a past Cursor chat by sessionIndex, then spawn a new local agent with that context plus your new instruction.",
      inputSchema: {
        sessionIndex: z.number().int().min(1).optional(),
        sessionId: z.string().uuid().optional(),
        cwd: z.string().min(1),
        prompt: z.string().min(1),
        model: z.string().optional(),
        mode: modeSchema,
        settingSources: z.array(settingSourceSchema).optional(),
        maxContextMessages: z.number().int().min(1).max(50).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ sessionIndex, sessionId, cwd, prompt, model, mode, settingSources, maxContextMessages }, extra) => {
      try {
        if (!sessionIndex && !sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        const summary = sessionId
          ? await loadSessionSummaryById(sessionId, maxContextMessages ?? 12)
          : await loadSessionSummary(sessionIndex!, maxContextMessages ?? 12);
        const composedPrompt = [
          "You are continuing work from a prior Cursor IDE conversation.",
          "Use the prior conversation summary below as context.",
          "",
          summary,
          "",
          "## New instruction",
          prompt,
        ].join("\n");
        return formatRun(
          await service.runLocalAgent(
            {
              prompt: composedPrompt,
              cwd,
              model,
              mode,
              settingSources,
              name: `continue-${sessionId ?? `session-${sessionIndex}`}`,
            },
            runHooksFrom(extra),
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_follow_up",
    {
      title: "Follow up local agent",
      description: "Send another prompt to an existing local SDK agent by agentId.",
      inputSchema: {
        agentId: z.string().min(1),
        prompt: z.string().min(1),
        cwd: z.string().min(1).optional(),
        model: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ agentId, prompt, cwd, model }, extra) => {
      try {
        return formatRun(
          await service.followUp({ agentId, prompt, cwd, model }, runHooksFrom(extra)),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_list_local_agents",
    {
      title: "List local SDK agents",
      description: "List persisted local Cursor SDK agents for a workspace cwd.",
      inputSchema: {
        cwd: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await service.listLocalAgents(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_get_run",
    {
      title: "Get local agent run",
      description: "Fetch status/result for a local SDK run by runId.",
      inputSchema: {
        runId: z.string().min(1),
        cwd: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId, cwd }) => {
      try {
        return jsonResult(await service.getRun({ agentId: "unused", runId, cwd }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_cancel_run",
    {
      title: "Cancel local agent run",
      description: "Cancel an in-progress local SDK run.",
      inputSchema: {
        runId: z.string().min(1),
        cwd: z.string().min(1).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ runId, cwd }) => {
      try {
        await service.cancelRun({ agentId: "unused", runId, cwd });
        return jsonResult({ cancelled: true, runId });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_whoami",
    {
      title: "Verify Cursor API key",
      description: "Check CURSOR_API_KEY authentication for local agent tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult(await service.whoami());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
