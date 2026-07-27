import type {
  AgentRunResult,
  FollowUpParams,
  InterceptAgentParams,
  ListLocalAgentsParams,
  LocalAgentService,
  QueryRunParams,
  RunLocalAgentParams,
  RunHooks,
} from "../../src/cursor-local.js";

export class FakeLocalAgentService implements LocalAgentService {
  whoamiResult: { apiKeyName: string; userId?: number; userEmail?: string } = {
    apiKeyName: "test-key",
    userEmail: "test@example.com",
  };

  runResult: AgentRunResult = {
    agentId: "agent-test-1",
    runId: "run-test-1",
    status: "finished",
    result: "done",
  };

  followUpResult: AgentRunResult = {
    agentId: "agent-test-1",
    runId: "run-test-2",
    status: "finished",
    result: "followed up",
  };

  listAgentsResult: unknown = { items: [{ agentId: "agent-test-1" }], nextCursor: undefined };

  getRunResult: unknown = {
    id: "run-test-1",
    agentId: "agent-test-1",
    status: "finished",
    result: "ok",
  };

  whoamiError: Error | undefined;
  runError: Error | undefined;
  followUpError: Error | undefined;
  listAgentsError: Error | undefined;
  getRunError: Error | undefined;
  cancelRunError: Error | undefined;

  lastRunParams: RunLocalAgentParams | undefined;
  lastRunHooks: RunHooks | undefined;
  lastFollowUpParams: FollowUpParams | undefined;
  lastInterceptParams: InterceptAgentParams | undefined;

  async whoami() {
    if (this.whoamiError) throw this.whoamiError;
    return this.whoamiResult;
  }

  async listModels() {
    return [{ id: "composer-2.5", displayName: "Composer 2.5" }];
  }

  async runLocalAgent(params: RunLocalAgentParams, hooks?: RunHooks) {
    this.lastRunParams = params;
    this.lastRunHooks = hooks;
    if (this.runError) throw this.runError;
    return this.runResult;
  }

  async followUp(params: FollowUpParams, hooks?: RunHooks) {
    this.lastFollowUpParams = params;
    void hooks;
    if (this.followUpError) throw this.followUpError;
    return this.followUpResult;
  }

  async interceptAgent(params: InterceptAgentParams, hooks?: RunHooks) {
    this.lastInterceptParams = params;
    return this.followUp(params, hooks);
  }

  async listActiveRuns(params: ListLocalAgentsParams) {
    void params;
    return { items: [{ agentId: "agent-test-1", runId: "run-test-1", status: "running" }] };
  }

  async listLocalAgents(params: ListLocalAgentsParams) {
    void params;
    if (this.listAgentsError) throw this.listAgentsError;
    return this.listAgentsResult;
  }

  async getAgent(params: QueryRunParams) {
    return { agentId: params.agentId };
  }

  async listRuns(params: QueryRunParams) {
    return { items: [{ id: "run-test-1", agentId: params.agentId, status: "finished" }] };
  }

  async getRun(params: QueryRunParams & { runId: string }) {
    void params;
    if (this.getRunError) throw this.getRunError;
    return this.getRunResult;
  }

  async cancelRun(params: QueryRunParams & { runId: string }) {
    void params;
    if (this.cancelRunError) throw this.cancelRunError;
  }
}
