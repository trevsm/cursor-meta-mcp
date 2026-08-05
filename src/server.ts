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
  abortIdeChat,
  createIdeChat,
  getIdeChatActivity,
  interceptIdeChat,
  listActiveIdeChats,
  sendToIdeChat,
} from "./ide-chat-control.js";
import {
  getChatUsage,
  getUsagePeriod,
  listChatUsage,
  rankRecentChatsByUsage,
  usageErrorMessage,
} from "./chat-usage.js";
import {
  exportChat,
  historyErrorMessage,
  listChats,
  loadSessionSummary,
  loadSessionSummaryById,
  searchChats,
  showChat,
} from "./history.js";
import { watchIdeChat } from "./watch-chat.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ServerInfo {
  name: string;
  version: string;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: "cursor-meta-mcp",
  version: "1.0.0",
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

const sessionIdSchema = z
  .string()
  .min(1)
  .refine((id) => /^[0-9a-f-]{36}$/i.test(id) || /^bc-[0-9a-f-]{36}$/i.test(id), {
    message: "sessionId must be a composer UUID or cloud agent id (bc-...)",
  });

const sessionSelectorSchema = {
  sessionIndex: z.number().int().min(1).optional(),
  sessionId: sessionIdSchema.optional(),
};

const ideChatControlSchema = {
  ...sessionSelectorSchema,
  prompt: z.string().min(1),
  cwd: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  model: z.string().optional(),
  mode: modeSchema,
  requireVisible: z
    .boolean()
    .optional()
    .describe(
      "When true, fail fast: sidebar-visible delivery is not supported (headless CLI only). Default false.",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "When true, allow headless send to cloud agent chats (bc-*). Response is in the tool result, not the sidebar.",
    ),
};

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
        "Load content of a past Cursor chat by sessionIndex or sessionId. Returns recent user/assistant text only (default 30 messages; max 500). Tool-only bubbles are omitted.",
      inputSchema: {
        sessionIndex: z.number().int().min(1).optional(),
        sessionId: sessionIdSchema.optional(),
        maxMessages: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIndex, sessionId, maxMessages }) => {
      try {
        if (!sessionIndex && !sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        return jsonResult(await showChat({ sessionIndex, sessionId, maxMessages }));
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
        "Create and run a headless local Cursor agent on this machine (agent/SDK). Returns agentId and runId for follow-ups. Does not open or update a sidebar chat tab. No cloud agents.",
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
    "meta_list_active_chats",
    {
      title: "List active IDE chats",
      description:
        "List Cursor IDE chats with recent activity or in-flight tool/generation signals from local storage.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        workspace: z.string().min(1).optional(),
        withinMs: z.number().int().min(1000).max(86_400_000).optional(),
        includeIdle: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult({ sessions: listActiveIdeChats(args) });
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_get_chat_activity",
    {
      title: "Get IDE chat activity",
      description:
        "Inspect whether a Cursor IDE chat appears active, blocked, or recently updated.",
      inputSchema: sessionSelectorSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIndex, sessionId }) => {
      try {
        if (!sessionIndex && !sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        return jsonResult(getIdeChatActivity({ sessionIndex, sessionId }));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_watch_chat",
    {
      title: "Watch IDE chat until idle",
      description:
        "Poll chat activity until the IDE session is idle, then optionally send a follow-up prompt.",
      inputSchema: {
        ...sessionSelectorSchema,
        followUpPrompt: z.string().min(1).optional(),
        cwd: z.string().min(1).optional(),
        workspace: z.string().min(1).optional(),
        model: z.string().optional(),
        mode: modeSchema,
        pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
        idleStableMs: z.number().int().min(500).max(120_000).optional(),
        timeoutMs: z.number().int().min(5000).max(3_600_000).optional(),
        sendIfAlreadyIdle: z.boolean().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (!params.sessionIndex && !params.sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        return jsonResult(await watchIdeChat(params));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_send_to_chat",
    {
      title: "Send message to IDE chat",
      description:
        "Run a headless agent with the same chat context via `agent --resume -p`. The response is returned in the tool result — it does NOT append to the Cursor sidebar transcript. Local composer UUIDs only unless force=true for bc-* cloud chats. Requires ~/.local/bin/agent login.",
      inputSchema: ideChatControlSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (!params.sessionIndex && !params.sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        return jsonResult(await sendToIdeChat(params));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_abort_chat",
    {
      title: "Abort IDE chat generation",
      description:
        "Best-effort stop for an in-flight Cursor IDE chat by marking composer state aborted in local storage.",
      inputSchema: sessionSelectorSchema,
      annotations: { destructiveHint: true },
    },
    async ({ sessionIndex, sessionId }) => {
      try {
        if (!sessionIndex && !sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        return jsonResult(await abortIdeChat({ sessionIndex, sessionId }));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_intercept_chat",
    {
      title: "Intercept IDE chat",
      description:
        "Best-effort abort of in-flight generation, then headless send via agent --resume -p (response in tool result, not sidebar).",
      inputSchema: {
        ...ideChatControlSchema,
        abortFirst: z.boolean().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (!params.sessionIndex && !params.sessionId) {
          return errorResult(new Error("Provide sessionIndex or sessionId."));
        }
        return jsonResult(await interceptIdeChat(params));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_create_chat",
    {
      title: "Create IDE chat",
      description:
        "Create a new empty Cursor chat via the Agent CLI and return its composerId for follow-up sends.",
      inputSchema: {},
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        return jsonResult(await createIdeChat());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_list_agent_runs",
    {
      title: "List SDK agent runs",
      description: "List runs for a local SDK agent by agentId.",
      inputSchema: {
        agentId: z.string().min(1),
        cwd: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId, cwd }) => {
      try {
        return jsonResult(await service.listRuns({ agentId, cwd }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_list_active_runs",
    {
      title: "List active SDK runs",
      description: "List in-progress local SDK agent runs for a workspace.",
      inputSchema: {
        cwd: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cwd, limit }) => {
      try {
        return jsonResult(await service.listActiveRuns({ cwd, limit }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_intercept_agent",
    {
      title: "Intercept SDK agent",
      description:
        "Cancel an in-progress SDK run (optional) and send a steering follow-up prompt to the same agent.",
      inputSchema: {
        agentId: z.string().min(1),
        prompt: z.string().min(1),
        cwd: z.string().min(1).optional(),
        model: z.string().optional(),
        runId: z.string().min(1).optional(),
        cancelFirst: z.boolean().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params, extra) => {
      try {
        return formatRun(await service.interceptAgent(params, runHooksFrom(extra)));
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

  server.registerTool(
    "meta_get_usage_period",
    {
      title: "Cursor billing period usage",
      description:
        "Fetch current billing-cycle usage summary from Cursor dashboard (requires local IDE login).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult(await getUsagePeriod());
      } catch (error) {
        return errorResult(usageErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_list_chat_usage",
    {
      title: "List chats by usage cost",
      description:
        "Aggregate Cursor dashboard usage events by conversationId. Returns includedDollars (plan/bonus burn) and onDemandDollars (pay-as-you-go) separately. Defaults to current billing cycle.",
      inputSchema: {
        startDate: z.string().optional().describe("ISO start date (optional; default billing cycle start)"),
        endDate: z.string().optional().describe("ISO end date (optional; default billing cycle end)"),
        limit: z.number().int().min(1).max(200).optional(),
        minCents: z.number().min(0).optional().describe("Only include chats with at least this many charged cents"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await listChatUsage(args));
      } catch (error) {
        return errorResult(usageErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_rank_recent_chat_usage",
    {
      title: "Rank recent chats by usage",
      description:
        "Take the N most recent local chats and rank by cost, splitting includedDollars vs onDemandDollars. Includes $0 chats. Usage is for the currently logged-in Cursor account only.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("How many recent chats to include (default 100)"),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await rankRecentChatsByUsage(args));
      } catch (error) {
        return errorResult(usageErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_chat_usage",
    {
      title: "Usage for one chat",
      description:
        "Return token and cost totals for a single chat (sessionId or sessionIndex), correlated via dashboard conversationId.",
      inputSchema: {
        sessionId: z.string().min(1).optional(),
        sessionIndex: z.number().int().min(1).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        includeEvents: z.boolean().optional().describe("Include individual usage event rows"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await getChatUsage(args));
      } catch (error) {
        return errorResult(usageErrorMessage(error));
      }
    },
  );

  return server;
}
