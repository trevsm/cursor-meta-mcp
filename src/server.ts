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
  exportChat,
  historyErrorMessage,
  listChats,
  loadSessionSummary,
  loadSessionSummaryById,
  searchChats,
  showChat,
} from "./history.js";
import { runRelentlessLoop } from "./relentless-loop.js";
import { orchestratePulse } from "./orchestrate-pulse.js";
import { runMission } from "./mission.js";
import { orchestrateLoop } from "./orchestrate-loop.js";
import { runConsciousnessPulse } from "./consciousness-pulse.js";
import {
  defaultCheckpointPath,
  readCheckpoint,
  runLongSession,
  spawnLongSession,
} from "./long-session.js";
import {
  resolveSentimentSessionIndex,
  runSentimentAnalysis,
} from "./sentiment-analysis.js";
import { watchIdeChat } from "./watch-chat.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ServerInfo {
  name: string;
  version: string;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: "cursor-meta-mcp",
  version: "0.5.0",
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

const sessionSelectorSchema = {
  sessionIndex: z.number().int().min(1).optional(),
  sessionId: z.string().uuid().optional(),
};

const ideChatControlSchema = {
  ...sessionSelectorSchema,
  prompt: z.string().min(1),
  cwd: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  model: z.string().optional(),
  mode: modeSchema,
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
        "Poll chat activity until the IDE session is idle, then optionally send a follow-up prompt. Replaces manual watcher loops.",
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
        "Send a new user message to an existing Cursor IDE chat via the Agent CLI (--resume composerId). Requires ~/.local/bin/agent login.",
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
        "Stop an in-flight IDE chat (best effort) and immediately send a new steering message via Agent CLI --resume.",
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
    "meta_sentiment_analysis",
    {
      title: "Analyze chat sentiment",
      description:
        "Multi-axis sentiment analysis over local Cursor chat history: frustration, confusion, satisfaction, valence. Surfaces false-completion patterns (user pushback after agent claimed done).",
      inputSchema: {
        workspace: z.string().min(1).optional(),
        sessionIndex: z.number().int().min(1).optional(),
        sessionId: z.string().uuid().optional(),
        topMessages: z.number().int().min(1).max(100).optional(),
        topSessions: z.number().int().min(1).max(50).optional(),
        includeClassificationInput: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionIndex, sessionId, ...rest }) => {
      try {
        const resolvedIndex = resolveSentimentSessionIndex(sessionIndex, sessionId);
        return jsonResult(
          runSentimentAnalysis({
            ...rest,
            sessionIndex: resolvedIndex,
          }),
        );
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_orchestrate_loop",
    {
      title: "Continuous orchestration loop",
      description:
        "Repeatedly scan and execute pulse orchestration plays until idle, maxCycles, or errors. Pass excludeSessionIndex to skip the conductor chat.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        workspace: z.string().min(1).optional(),
        dryRun: z.boolean().optional(),
        allowWatch: z.boolean().optional(),
        allowContinue: z.boolean().optional(),
        allowIntercept: z.boolean().optional(),
        allowSpawn: z.boolean().optional(),
        maxActions: z.number().int().min(1).max(20).optional(),
        excludeSessionIds: z.array(z.string().uuid()).optional(),
        excludeSessionIndexes: z.array(z.number().int().min(1)).optional(),
        maxCycles: z.number().int().min(1).max(50).optional(),
        intervalMs: z.number().int().min(5000).max(600_000).optional(),
        stopWhenIdle: z.boolean().optional(),
        pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
        idleStableMs: z.number().int().min(500).max(120_000).optional(),
        timeoutMs: z.number().int().min(5000).max(3_600_000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        return jsonResult(await orchestrateLoop(params, service));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_orchestrate_pulse",
    {
      title: "Run consciousness pulse actions",
      description:
        "Scan recent chats for orchestration opportunities and optionally execute WATCH/CONTINUE/INTERCEPT/SPAWN plays. CONTINUE and WATCH allowed by default; INTERCEPT and SPAWN require explicit opt-in.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        workspace: z.string().min(1).optional(),
        dryRun: z.boolean().optional(),
        allowWatch: z.boolean().optional(),
        allowContinue: z.boolean().optional(),
        allowIntercept: z.boolean().optional(),
        allowSpawn: z.boolean().optional(),
        maxActions: z.number().int().min(1).max(20).optional(),
        excludeSessionIds: z.array(z.string().uuid()).optional(),
        excludeSessionIndexes: z.array(z.number().int().min(1)).optional(),
        pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
        idleStableMs: z.number().int().min(500).max(120_000).optional(),
        timeoutMs: z.number().int().min(5000).max(3_600_000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        return jsonResult(await orchestratePulse(params, service));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_consciousness_pulse",
    {
      title: "Consciousness pulse scan",
      description:
        "Live orchestration scan: active chats, frustration signals, and recommended WATCH/INTERCEPT/CONTINUE/SPAWN actions. Meta/strategy discussion is damped to avoid false intercepts.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        workspace: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        return jsonResult(runConsciousnessPulse(params));
      } catch (error) {
        return errorResult(historyErrorMessage(error));
      }
    },
  );

  server.registerTool(
    "meta_mission",
    {
      title: "Run a mission until success criteria pass",
      description:
        "High-level primitive: state a goal and success criteria, then run the relentless worker/critic loop until approved or maxIterations. Hides tool orchestration behind one call.",
      inputSchema: {
        goal: z.string().min(1),
        successCriteria: z.array(z.string().min(1)).optional(),
        cwd: z.string().min(1),
        target: z.enum(["sdk", "ide"]).optional(),
        sessionIndex: z.number().int().min(1).optional(),
        sessionId: z.string().uuid().optional(),
        maxIterations: z.number().int().min(1).max(20).optional(),
        approvalScore: z.number().int().min(0).max(100).optional(),
        model: z.string().optional(),
        mode: modeSchema,
        pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
        idleStableMs: z.number().int().min(500).max(120_000).optional(),
        waitTimeoutMs: z.number().int().min(5000).max(3_600_000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params, extra) => {
      try {
        return jsonResult(await runMission(service, params, runHooksFrom(extra)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_relentless_loop",
    {
      title: "Relentless self-critique loop",
      description:
        "Run a task, judge the output with a separate critic pass, and keep iterating until approved or maxIterations. Supports SDK agents (default) or IDE chats (sessionIndex/sessionId + watch until idle).",
      inputSchema: {
        task: z.string().min(1),
        cwd: z.string().min(1),
        target: z.enum(["sdk", "ide"]).optional(),
        sessionIndex: z.number().int().min(1).optional(),
        sessionId: z.string().uuid().optional(),
        maxIterations: z.number().int().min(1).max(20).optional(),
        approvalScore: z.number().int().min(0).max(100).optional(),
        rubric: z.string().optional(),
        model: z.string().optional(),
        mode: modeSchema,
        pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
        idleStableMs: z.number().int().min(500).max(120_000).optional(),
        waitTimeoutMs: z.number().int().min(5000).max(3_600_000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params, extra) => {
      try {
        return jsonResult(await runRelentlessLoop(service, params, runHooksFrom(extra)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "meta_long_session",
    {
      title: "Long-running IDE session",
      description:
        "Keep an IDE chat working autonomously for a wall-clock duration: wait for idle, send follow-up, repeat. Use spawn=true (default) to detach a background process with checkpoint + log files. Use spawn=false only for short experiments (MCP may timeout).",
      inputSchema: {
        cwd: z.string().min(1),
        sessionIndex: z.number().int().min(1).optional(),
        sessionId: z.string().uuid().optional(),
        durationMs: z.number().int().min(60_000).max(86_400_000).optional(),
        maxTicks: z.number().int().min(1).max(5000).optional(),
        tickIntervalMs: z.number().int().min(1000).max(600_000).optional(),
        waitTimeoutMs: z.number().int().min(60_000).max(86_400_000).optional(),
        pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
        idleStableMs: z.number().int().min(500).max(120_000).optional(),
        prompt: z.string().min(1).optional(),
        checkpointPath: z.string().min(1).optional(),
        spawn: z.boolean().optional(),
        readCheckpoint: z.boolean().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (params.readCheckpoint) {
          const path =
            params.checkpointPath ??
            defaultCheckpointPath(params.sessionId, params.sessionIndex);
          return jsonResult(readCheckpoint(path));
        }
        if (params.spawn ?? true) {
          if (params.sessionIndex == null && !params.sessionId) {
            return errorResult("Provide sessionIndex or sessionId.");
          }
          return jsonResult(spawnLongSession(params));
        }
        return jsonResult(await runLongSession(params));
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
