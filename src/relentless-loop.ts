import type { AgentRunResult, ConversationMode, LocalAgentService, RunHooks } from "./cursor-local.js";
import { getChatActivity, type ChatActivity } from "./chat-activity.js";
import { getChatById, getChatByIndex } from "./history-store.js";
import { sendToIdeChat } from "./ide-chat-control.js";

export interface JudgeVerdict {
  approved: boolean;
  score: number;
  issues: string[];
  nextPrompt: string;
}

export interface RelentlessLoopParams {
  task: string;
  cwd: string;
  target?: "sdk" | "ide";
  sessionIndex?: number;
  sessionId?: string;
  maxIterations?: number;
  approvalScore?: number;
  rubric?: string;
  model?: string;
  mode?: ConversationMode;
  pollIntervalMs?: number;
  idleStableMs?: number;
  waitTimeoutMs?: number;
}

export interface RelentlessIteration {
  iteration: number;
  phase: "work" | "judge";
  approved?: boolean;
  score?: number;
  issues?: string[];
  result: string;
  agentId?: string;
  runId?: string;
}

export interface RelentlessLoopResult {
  approved: boolean;
  iterations: number;
  finalResult: string;
  workerAgentId?: string;
  sessionId?: string;
  history: RelentlessIteration[];
}

const DEFAULT_RUBRIC = [
  "Did the output fully satisfy the original task without hand-waving?",
  "Were changes verified (tests, typecheck, lint, or explicit runtime check)?",
  "Is the solution minimal — no unrelated edits or scope creep?",
  "Would a senior engineer approve this without another revision?",
].join("\n");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildJudgePrompt(task: string, result: string, rubric = DEFAULT_RUBRIC): string {
  return [
    "You are a ruthless self-critic reviewing an agent's own work.",
    "Be harsh. Approve only when the work is genuinely complete and verified.",
    "",
    "## Original task",
    task,
    "",
    "## Agent output to judge",
    result || "(empty output)",
    "",
    "## Rubric",
    rubric,
    "",
    "Respond with ONLY valid JSON (no markdown fences):",
    '{"approved":boolean,"score":0-100,"issues":["..."],"nextPrompt":"..."}',
    "",
    "Rules:",
    "- approved=true ONLY if score>=85 and zero critical gaps.",
    "- If not approved, nextPrompt must be concrete fix instructions the worker can execute immediately.",
    "- Do not praise. List specific failures in issues.",
  ].join("\n");
}

export function parseJudgeVerdict(text: string, approvalScore = 85): JudgeVerdict {
  const match = text.match(/\{[\s\S]*"approved"[\s\S]*?\}/);
  if (!match) {
    throw new Error(`Judge response missing JSON verdict. Got: ${text.slice(0, 400)}`);
  }

  const parsed = JSON.parse(match[0]) as Partial<JudgeVerdict>;
  const score = typeof parsed.score === "number" ? parsed.score : 0;
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((item): item is string => typeof item === "string")
    : [];
  const nextPrompt = typeof parsed.nextPrompt === "string" ? parsed.nextPrompt.trim() : "";
  const approved = parsed.approved === true && score >= approvalScore;

  if (!approved && !nextPrompt) {
    throw new Error("Judge rejected work but did not provide nextPrompt.");
  }

  return { approved, score, issues, nextPrompt };
}

export async function waitForChatIdle(
  sessionId: string,
  opts: {
    pollIntervalMs?: number;
    idleStableMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<ChatActivity> {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const idleStableMs = opts.idleStableMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const started = Date.now();
  let idleSince: number | undefined;

  while (Date.now() - started < timeoutMs) {
    const activity = getChatActivity(sessionId);
    if (activity.activityLevel === "active") {
      idleSince = undefined;
    } else if (!idleSince) {
      idleSince = Date.now();
    } else if (Date.now() - idleSince >= idleStableMs) {
      return activity;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for chat ${sessionId} to become idle.`);
}

function resolveSession(params: RelentlessLoopParams): { sessionId: string; cwd: string } {
  if (params.sessionId) {
    const session = getChatById(params.sessionId);
    return { sessionId: params.sessionId, cwd: params.cwd || session.workspace };
  }
  if (params.sessionIndex != null) {
    const session = getChatByIndex(params.sessionIndex);
    return { sessionId: session.id, cwd: params.cwd || session.workspace };
  }
  throw new Error("IDE relentless loop requires sessionIndex or sessionId.");
}

function lastAssistantText(sessionIndex?: number, sessionId?: string): string {
  const session =
    sessionId != null ? getChatById(sessionId) : getChatByIndex(sessionIndex!);
  const assistants = session.messages.filter((message) => message.role === "assistant");
  const last = assistants.at(-1);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return "";
}

async function judgeOutput(
  service: LocalAgentService,
  params: RelentlessLoopParams,
  result: string,
  iteration: number,
  hooks?: RunHooks,
): Promise<{ verdict: JudgeVerdict; run: AgentRunResult }> {
  const judgePrompt = buildJudgePrompt(params.task, result, params.rubric);
  const run = await service.runLocalAgent(
    {
      prompt: judgePrompt,
      cwd: params.cwd,
      model: params.model,
      mode: "ask",
      name: `relentless-critic-${iteration}`,
    },
    hooks,
  );
  const verdict = parseJudgeVerdict(run.result, params.approvalScore ?? 85);
  return { verdict, run };
}

async function runRelentlessSdkLoop(
  service: LocalAgentService,
  params: RelentlessLoopParams,
  hooks?: RunHooks,
): Promise<RelentlessLoopResult> {
  const maxIterations = params.maxIterations ?? 8;
  const history: RelentlessIteration[] = [];

  const first = await service.runLocalAgent(
    {
      prompt: params.task,
      cwd: params.cwd,
      model: params.model,
      mode: params.mode,
      name: "relentless-worker",
    },
    hooks,
  );

  history.push({
    iteration: 0,
    phase: "work",
    result: first.result,
    agentId: first.agentId,
    runId: first.runId,
  });

  let workerAgentId = first.agentId;
  let lastResult = first.result;
  const usesPersistentWorker = workerAgentId !== "cli-session";

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const { verdict, run: judgeRun } = await judgeOutput(service, params, lastResult, iteration, hooks);
    history.push({
      iteration,
      phase: "judge",
      approved: verdict.approved,
      score: verdict.score,
      issues: verdict.issues,
      result: judgeRun.result,
      agentId: judgeRun.agentId,
      runId: judgeRun.runId,
    });

    if (verdict.approved) {
      return {
        approved: true,
        iterations: iteration,
        finalResult: lastResult,
        workerAgentId,
        history,
      };
    }

    if (iteration >= maxIterations) {
      break;
    }

    const fix = usesPersistentWorker
      ? await service.followUp(
          {
            agentId: workerAgentId,
            prompt: verdict.nextPrompt,
            cwd: params.cwd,
            model: params.model,
          },
          hooks,
        )
      : await service.runLocalAgent(
          {
            prompt: [
              "## Original task",
              params.task,
              "",
              "## Prior attempt (rejected)",
              lastResult,
              "",
              "## Required fixes",
              verdict.nextPrompt,
            ].join("\n"),
            cwd: params.cwd,
            model: params.model,
            mode: params.mode,
            name: `relentless-worker-${iteration}`,
          },
          hooks,
        );

    if (!usesPersistentWorker) {
      workerAgentId = fix.agentId;
    }

    history.push({
      iteration,
      phase: "work",
      result: fix.result,
      agentId: fix.agentId,
      runId: fix.runId,
    });
    lastResult = fix.result;
  }

  return {
    approved: false,
    iterations: maxIterations,
    finalResult: lastResult,
    workerAgentId,
    history,
  };
}

async function runRelentlessIdeLoop(
  service: LocalAgentService,
  params: RelentlessLoopParams,
  hooks?: RunHooks,
): Promise<RelentlessLoopResult> {
  const maxIterations = params.maxIterations ?? 8;
  const { sessionId, cwd } = resolveSession(params);
  const history: RelentlessIteration[] = [];

  const firstSend = await sendToIdeChat({
    sessionId,
    prompt: params.task,
    cwd,
    model: params.model,
    mode: params.mode,
  });
  await waitForChatIdle(sessionId, {
    pollIntervalMs: params.pollIntervalMs,
    idleStableMs: params.idleStableMs,
    timeoutMs: params.waitTimeoutMs,
  });

  let lastResult = lastAssistantText(params.sessionIndex, sessionId);
  history.push({
    iteration: 0,
    phase: "work",
    result: lastResult || firstSend.result,
  });

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const { verdict, run: judgeRun } = await judgeOutput(service, params, lastResult, iteration, hooks);
    history.push({
      iteration,
      phase: "judge",
      approved: verdict.approved,
      score: verdict.score,
      issues: verdict.issues,
      result: judgeRun.result,
      agentId: judgeRun.agentId,
      runId: judgeRun.runId,
    });

    if (verdict.approved) {
      return {
        approved: true,
        iterations: iteration,
        finalResult: lastResult,
        sessionId,
        history,
      };
    }

    if (iteration >= maxIterations) {
      break;
    }

    await sendToIdeChat({
      sessionId,
      prompt: verdict.nextPrompt,
      cwd,
      model: params.model,
      mode: params.mode,
    });
    await waitForChatIdle(sessionId, {
      pollIntervalMs: params.pollIntervalMs,
      idleStableMs: params.idleStableMs,
      timeoutMs: params.waitTimeoutMs,
    });

    lastResult = lastAssistantText(params.sessionIndex, sessionId);
    history.push({
      iteration,
      phase: "work",
      result: lastResult,
    });
  }

  return {
    approved: false,
    iterations: maxIterations,
    finalResult: lastResult,
    sessionId,
    history,
  };
}

export async function runRelentlessLoop(
  service: LocalAgentService,
  params: RelentlessLoopParams,
  hooks?: RunHooks,
): Promise<RelentlessLoopResult> {
  if (!params.task.trim()) {
    throw new Error("task is required.");
  }
  if (!params.cwd.trim()) {
    throw new Error("cwd is required.");
  }

  const target = params.target ?? (params.sessionIndex || params.sessionId ? "ide" : "sdk");
  if (target === "ide") {
    return runRelentlessIdeLoop(service, params, hooks);
  }
  return runRelentlessSdkLoop(service, params, hooks);
}
