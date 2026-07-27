import { Agent, Cursor } from "@cursor/sdk";
import type {
  AgentDefinition,
  McpServerConfig,
  Run,
  RunResult,
  SDKMessage,
  SettingSource,
} from "@cursor/sdk";

import {
  agentCliWhoami,
  isAgentCliLoggedIn,
  runAgentCliPrompt,
  shouldUseAgentCliFallback,
} from "./agent-cli.js";
import {
  assertBudgetAllowed,
  recordBudgetEvent,
  recordSdkRunComplete,
  recordSpawn,
} from "./plan-budget.js";

export type ConversationMode = "agent" | "plan" | "ask";
export type McpServerInput = McpServerConfig;

export interface RunProgressEvent {
  type: SDKMessage["type"];
  message: string;
}

export interface RunHooks {
  signal?: AbortSignal;
  onProgress?: (event: RunProgressEvent) => void;
}

export interface AgentDefinitionInput {
  description: string;
  prompt: string;
  model?: string | "inherit";
  mcpServers?: Array<string | Record<string, McpServerInput>>;
}

export interface RunLocalAgentParams {
  prompt: string;
  cwd: string | string[];
  model?: string;
  mode?: ConversationMode;
  settingSources?: SettingSource[];
  mcpServers?: Record<string, McpServerInput>;
  agents?: Record<string, AgentDefinitionInput>;
  sandboxOptions?: { enabled: boolean };
  autoReview?: boolean;
  name?: string;
}

export interface FollowUpParams {
  agentId: string;
  prompt: string;
  model?: string;
  cwd?: string;
}

export interface InterceptAgentParams extends FollowUpParams {
  cancelFirst?: boolean;
  runId?: string;
}

export interface ActiveRunSummary {
  agentId: string;
  runId: string;
  status: string;
  cwd?: string;
  createdAt?: number;
}

function toActiveRunSummary(
  run: { id: string; agentId: string; status: string; createdAt?: number },
  cwd?: string,
): ActiveRunSummary {
  return {
    agentId: run.agentId,
    runId: run.id,
    status: run.status,
    cwd,
    createdAt: run.createdAt,
  };
}

export interface AgentRunResult {
  agentId: string;
  runId: string;
  status: string;
  result: string;
  durationMs?: number;
  requestId?: string;
  model?: string;
}

export interface QueryRunParams {
  agentId: string;
  runId?: string;
  cwd?: string;
}

export interface ListLocalAgentsParams {
  cwd?: string;
  limit?: number;
  cursor?: string;
}

export interface LocalAgentService {
  whoami(): Promise<{ apiKeyName: string; userId?: number; userEmail?: string }>;
  listModels(): Promise<Array<{ id: string; displayName: string; description?: string }>>;
  runLocalAgent(params: RunLocalAgentParams, hooks?: RunHooks): Promise<AgentRunResult>;
  followUp(params: FollowUpParams, hooks?: RunHooks): Promise<AgentRunResult>;
  interceptAgent(params: InterceptAgentParams, hooks?: RunHooks): Promise<AgentRunResult>;
  listActiveRuns(params: ListLocalAgentsParams): Promise<{ items: ActiveRunSummary[] }>;
  listLocalAgents(params: ListLocalAgentsParams): Promise<unknown>;
  getAgent(params: QueryRunParams): Promise<unknown>;
  listRuns(params: QueryRunParams): Promise<unknown>;
  getRun(params: QueryRunParams & { runId: string }): Promise<unknown>;
  cancelRun(params: QueryRunParams & { runId: string }): Promise<void>;
}

export interface LocalAgentServiceOptions {
  apiKey?: string;
  defaultModel?: string;
}

async function disposeAgent(agent: {
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}): Promise<void> {
  const asyncDispose = agent[Symbol.asyncDispose];
  if (typeof asyncDispose === "function") {
    await asyncDispose.call(agent);
    return;
  }
  agent.close?.();
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summarizeSdkMessage(message: SDKMessage): RunProgressEvent | undefined {
  switch (message.type) {
    case "system": {
      const model = message.model?.id ? ` (model ${message.model.id})` : "";
      return { type: message.type, message: `Agent initialized${model}.` };
    }
    case "tool_call":
      return { type: message.type, message: `tool ${message.name}: ${message.status}` };
    case "thinking":
      return { type: message.type, message: "thinking…" };
    case "status": {
      const detail = message.message ? `: ${clip(message.message)}` : "";
      return { type: message.type, message: `status ${message.status}${detail}` };
    }
    case "task": {
      const text = message.text ? clip(message.text) : (message.status ?? "");
      if (!text) return undefined;
      return { type: message.type, message: `task: ${text}` };
    }
    default:
      return undefined;
  }
}

const SENTENCE_END = /[.!?。！？\n]["'”’)）]?\s*$/;

class ProgressReducer {
  private assistantBuffer = "";
  private lastLine?: string;

  constructor(private readonly emit: (event: RunProgressEvent) => void) {}

  push(message: SDKMessage): void {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") this.assistantBuffer += block.text;
      }
      if (SENTENCE_END.test(this.assistantBuffer)) this.flushAssistant();
      return;
    }
    this.flushAssistant();
    const event = summarizeSdkMessage(message);
    if (event) this.line(event.type, event.message);
  }

  end(): void {
    this.flushAssistant();
  }

  private flushAssistant(): void {
    const text = clip(this.assistantBuffer);
    this.assistantBuffer = "";
    if (text) this.line("assistant", text);
  }

  private line(type: RunProgressEvent["type"], message: string): void {
    if (message === this.lastLine) return;
    this.lastLine = message;
    this.emit({ type, message });
  }
}

export class CursorLocalService implements LocalAgentService {
  private readonly apiKey?: string;
  private readonly defaultModel: string;

  constructor(options: LocalAgentServiceOptions = {}) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? "composer-2.5";
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error(
        "CURSOR_API_KEY is not set. Create a key at Cursor Dashboard → API Keys, or log in with ~/.local/bin/agent login for CLI fallback.",
      );
    }
    return this.apiKey;
  }

  private async ensureSpawnAuth(): Promise<"sdk" | "cli"> {
    if (this.apiKey) return "sdk";
    if (await isAgentCliLoggedIn()) return "cli";
    throw new Error(
      "No auth available. Set CURSOR_API_KEY or run ~/.local/bin/agent login.",
    );
  }

  private normalizeCwd(cwd: string | string[]): string {
    return Array.isArray(cwd) ? cwd[0] : cwd;
  }

  async whoami() {
    if (shouldUseAgentCliFallback(this.apiKey) && (await isAgentCliLoggedIn())) {
      return agentCliWhoami();
    }
    const user = await Cursor.me({ apiKey: this.requireApiKey() });
    return {
      apiKeyName: user.apiKeyName,
      userId: user.userId,
      userEmail: user.userEmail,
    };
  }

  async listModels() {
    const models = await Cursor.models.list({ apiKey: this.requireApiKey() });
    return models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: model.description,
    }));
  }

  private toSdkAgents(
    agents: Record<string, AgentDefinitionInput> | undefined,
  ): Record<string, AgentDefinition> | undefined {
    if (!agents) return undefined;
    return Object.fromEntries(
      Object.entries(agents).map(([name, definition]) => [
        name,
        {
          description: definition.description,
          prompt: definition.prompt,
          model:
            definition.model === undefined
              ? undefined
              : definition.model === "inherit"
                ? "inherit"
                : { id: definition.model },
          mcpServers: definition.mcpServers,
        },
      ]),
    );
  }

  private wireAbort(run: Run, signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    if (signal.aborted) {
      void run.cancel().catch(() => {});
      return () => {};
    }
    const onAbort = (): void => {
      void run.cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }

  private formatRun(agentId: string, run: Run, result: RunResult): AgentRunResult {
    return {
      agentId,
      runId: run.id,
      status: result.status,
      result: result.result ?? "",
      durationMs: result.durationMs,
      requestId: result.requestId,
      model: result.model?.id,
    };
  }

  private async driveRun(agentId: string, run: Run, hooks?: RunHooks): Promise<AgentRunResult> {
    const removeAbort = this.wireAbort(run, hooks?.signal);
    try {
      if (hooks?.onProgress && run.supports("stream")) {
        const reducer = new ProgressReducer(hooks.onProgress);
        try {
          for await (const message of run.stream()) {
            reducer.push(message);
          }
        } catch {
          // Streaming is advisory.
        } finally {
          reducer.end();
        }
      }
      const result = await run.wait();
      return this.formatRun(agentId, run, result);
    } finally {
      removeAbort();
    }
  }

  async runLocalAgent(params: RunLocalAgentParams, hooks?: RunHooks): Promise<AgentRunResult> {
    assertBudgetAllowed("spawn_sdk");
    recordSpawn("spawn_sdk", params.name ?? "runLocalAgent");

    const auth = await this.ensureSpawnAuth();
    if (auth === "cli") {
      const cwd = this.normalizeCwd(params.cwd);
      const cli = await runAgentCliPrompt({
        prompt: params.prompt,
        cwd,
        mode: params.mode,
        model: params.model,
      });
      return {
        agentId: "cli-session",
        runId: `cli-${Date.now()}`,
        status: cli.status,
        result: cli.result,
      };
    }

    const apiKey = this.requireApiKey();
    const agent = await Agent.create({
      apiKey,
      name: params.name,
      model: { id: params.model ?? this.defaultModel },
      mode: params.mode === "ask" ? "agent" : params.mode,
      local: {
        cwd: params.cwd,
        settingSources: params.settingSources ?? [],
        sandboxOptions: params.sandboxOptions,
        autoReview: params.autoReview,
      },
      mcpServers: params.mcpServers,
      agents: this.toSdkAgents(params.agents),
    });
    try {
      const run = await agent.send(params.prompt);
      const result = await this.driveRun(agent.agentId, run, hooks);
      recordSdkRunComplete({
        durationMs: result.durationMs,
        model: result.model ?? params.model ?? this.defaultModel,
        source: params.name ?? "runLocalAgent",
      });
      return result;
    } finally {
      await disposeAgent(agent);
    }
  }

  async interceptAgent(params: InterceptAgentParams, hooks?: RunHooks): Promise<AgentRunResult> {
    if (params.cancelFirst ?? true) {
      if (params.runId) {
        await this.cancelRun({ agentId: params.agentId, runId: params.runId, cwd: params.cwd });
      } else {
        await this.cancelActiveRunsForAgent(params.agentId, params.cwd);
      }
    }
    return this.followUp(params, hooks);
  }

  private async cancelActiveRunsForAgent(agentId: string, cwd?: string): Promise<void> {
    if (agentId === "cli-session" || agentId.startsWith("bc-")) return;
    const runs = await this.listRuns({ agentId, cwd });
    const items = (runs as { items?: Array<{ id: string; status: string }> }).items ?? [];
    for (const run of items) {
      if (run.status === "running") {
        await this.cancelRun({ agentId, runId: run.id, cwd });
      }
    }
  }

  async listActiveRuns(params: ListLocalAgentsParams): Promise<{ items: ActiveRunSummary[] }> {
    const agents = (await this.listLocalAgents(params)) as {
      items?: Array<{ agentId: string; status?: string; cwd?: string }>;
    };
    const active: ActiveRunSummary[] = [];

    for (const agent of agents.items ?? []) {
      const agentCwd = agent.cwd ?? params.cwd;
      const runs = await this.listRuns({ agentId: agent.agentId, cwd: agentCwd });
      const items =
        (runs as { items?: Array<{ id: string; agentId: string; status: string; createdAt?: number }> })
          .items ?? [];

      for (const run of items) {
        if (run.status === "running") {
          active.push(toActiveRunSummary(run, agentCwd));
        }
      }
    }

    return { items: active };
  }

  async followUp(params: FollowUpParams, hooks?: RunHooks): Promise<AgentRunResult> {
    assertBudgetAllowed("follow_up_sdk");

    if (params.agentId === "cli-session" || shouldUseAgentCliFallback(this.apiKey)) {
      if (!(await isAgentCliLoggedIn())) {
        throw new Error("CLI follow-up requires ~/.local/bin/agent login.");
      }
      if (!params.cwd) {
        throw new Error("cwd is required for CLI follow-up.");
      }
      const cli = await runAgentCliPrompt({
        prompt: params.prompt,
        cwd: params.cwd,
        model: params.model,
      });
      return {
        agentId: "cli-session",
        runId: `cli-${Date.now()}`,
        status: cli.status,
        result: cli.result,
      };
    }

    if (params.agentId.startsWith("bc-")) {
      throw new Error("Cloud agents are not supported by this local-only server.");
    }
    const agent = await Agent.resume(params.agentId, {
      apiKey: this.requireApiKey(),
      model: { id: this.defaultModel },
      ...(params.cwd ? { local: { cwd: params.cwd } } : {}),
    });
    try {
      const run = await agent.send(
        params.prompt,
        params.model ? { model: { id: params.model } } : undefined,
      );
      const result = await this.driveRun(agent.agentId, run, hooks);
      recordSdkRunComplete({
        durationMs: result.durationMs,
        model: result.model ?? params.model ?? this.defaultModel,
        source: "followUp",
      });
      return result;
    } finally {
      await disposeAgent(agent);
    }
  }

  async listLocalAgents(params: ListLocalAgentsParams) {
    return Agent.list({
      runtime: "local",
      cwd: params.cwd,
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  async getAgent(params: QueryRunParams) {
    if (params.agentId.startsWith("bc-")) {
      throw new Error("Cloud agents are not supported by this local-only server.");
    }
    return Agent.get(params.agentId, {
      cwd: params.cwd,
      apiKey: this.apiKey,
    });
  }

  async listRuns(params: QueryRunParams) {
    if (params.agentId.startsWith("bc-")) {
      throw new Error("Cloud agents are not supported by this local-only server.");
    }
    const runs = await Agent.listRuns(params.agentId, {
      runtime: "local",
      cwd: params.cwd,
    });
    return {
      ...runs,
      items: runs.items.map((run) => ({
        id: run.id,
        agentId: run.agentId,
        status: run.status,
        result: run.result,
        requestId: run.requestId,
        model: run.model,
        durationMs: run.durationMs,
        createdAt: run.createdAt,
      })),
    };
  }

  async getRun(params: QueryRunParams & { runId: string }) {
    const run = await Agent.getRun(params.runId, {
      runtime: "local",
      cwd: params.cwd,
    });
    return {
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      result: run.result,
      requestId: run.requestId,
      model: run.model,
      durationMs: run.durationMs,
      createdAt: run.createdAt,
    };
  }

  async cancelRun(params: QueryRunParams & { runId: string }) {
    const run = await Agent.getRun(params.runId, {
      runtime: "local",
      cwd: params.cwd,
    });
    await run.cancel();
  }
}
