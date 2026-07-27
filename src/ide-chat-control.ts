import {
  abortIdeChatInStorage,
  getChatActivity,
  getChatActivityByIndex,
  listActiveChats,
  type ChatActivity,
  type ListActiveChatsArgs,
} from "./chat-activity.js";
import {
  createAgentChat,
  isAgentCliLoggedIn,
  runAgentCliResume,
  type AgentCliRunResult,
} from "./agent-cli.js";
import {
  assessIdeChatDelivery,
  assertIdeChatDeliveryAllowed,
  type IdeChatDeliveryAssessment,
  type IdeChatDeliveryInfo,
} from "./chat-session.js";

export interface SendToIdeChatParams {
  sessionId?: string;
  sessionIndex?: number;
  prompt: string;
  cwd?: string;
  workspace?: string;
  mode?: "agent" | "plan" | "ask";
  model?: string;
  /** When true, fail unless sidebar injection is supported (it is not today). */
  requireVisible?: boolean;
  /** Bypass cloud-agent guard; still headless — response in tool result only. */
  force?: boolean;
}

export interface InterceptIdeChatParams extends SendToIdeChatParams {
  abortFirst?: boolean;
}

export interface IdeChatActionResult extends AgentCliRunResult {
  sessionId: string;
  activityBefore?: ChatActivity;
  abort?: { attempted: boolean; aborted: boolean; previousStatus?: string };
  delivery: IdeChatDeliveryInfo;
  sessionKind: IdeChatDeliveryAssessment["sessionKind"];
  warnings: string[];
}

async function requireCliLogin(): Promise<void> {
  if (!(await isAgentCliLoggedIn())) {
    throw new Error(
      "Cursor Agent CLI is not logged in. Run ~/.local/bin/agent login to send messages to IDE chats.",
    );
  }
}

function resolveSessionId(
  params: { sessionId?: string; sessionIndex?: number },
  opts: { allowMissingActivity?: boolean } = {},
): {
  sessionId: string;
  activity?: ChatActivity;
} {
  if (params.sessionId) {
    try {
      return { sessionId: params.sessionId, activity: getChatActivity(params.sessionId) };
    } catch (error) {
      if (opts.allowMissingActivity) {
        return { sessionId: params.sessionId };
      }
      throw error;
    }
  }
  if (params.sessionIndex != null) {
    const activity = getChatActivityByIndex(params.sessionIndex);
    return { sessionId: activity.sessionId, activity };
  }
  throw new Error("Provide sessionId or sessionIndex.");
}

function loadOptionalActivity(sessionId: string, activity?: ChatActivity): ChatActivity | undefined {
  if (activity) return activity;
  try {
    return getChatActivity(sessionId);
  } catch {
    return undefined;
  }
}

export async function sendToIdeChat(params: SendToIdeChatParams): Promise<IdeChatActionResult> {
  await requireCliLogin();
  const { sessionId, activity } = resolveSessionId(params, { allowMissingActivity: true });
  const activityBefore = loadOptionalActivity(sessionId, activity);
  const assessment = assessIdeChatDelivery(sessionId, activityBefore);
  assertIdeChatDeliveryAllowed(assessment, {
    requireVisible: params.requireVisible,
    force: params.force,
  });

  const cwd = params.cwd ?? activityBefore?.workspace;
  if (!cwd || cwd === "unknown") {
    throw new Error("cwd or workspace is required when the chat workspace is unknown.");
  }

  const cli = await runAgentCliResume({
    chatId: sessionId,
    prompt: params.prompt,
    cwd,
    workspace: params.workspace ?? cwd,
    mode: params.mode,
    model: params.model,
  });

  return {
    ...cli,
    sessionId,
    activityBefore,
    delivery: assessment.delivery,
    sessionKind: assessment.sessionKind,
    warnings: assessment.warnings,
  };
}

export async function abortIdeChat(params: {
  sessionId?: string;
  sessionIndex?: number;
}): Promise<{ sessionId: string; activityBefore: ChatActivity; abort: ReturnType<typeof abortIdeChatInStorage> }> {
  const { sessionId, activity } = resolveSessionId(params);
  const abort = abortIdeChatInStorage(sessionId);
  return {
    sessionId,
    activityBefore: activity!,
    abort,
  };
}

export async function interceptIdeChat(params: InterceptIdeChatParams): Promise<IdeChatActionResult> {
  const abortFirst = params.abortFirst ?? true;
  const { sessionId, activity } = resolveSessionId(params);

  let abortResult: IdeChatActionResult["abort"];
  if (abortFirst) {
    const abort = abortIdeChatInStorage(sessionId);
    abortResult = { attempted: true, ...abort };
  }

  const sent = await sendToIdeChat({
    ...params,
    sessionId,
  });

  return {
    ...sent,
    activityBefore: activity,
    abort: abortResult,
  };
}

export async function createIdeChat(): Promise<{ sessionId: string }> {
  await requireCliLogin();
  return { sessionId: await createAgentChat() };
}

export function listActiveIdeChats(args: ListActiveChatsArgs = {}): ChatActivity[] {
  return listActiveChats(args);
}

export function getIdeChatActivity(args: { sessionId?: string; sessionIndex?: number }): ChatActivity {
  if (args.sessionId) return getChatActivity(args.sessionId);
  if (args.sessionIndex != null) return getChatActivityByIndex(args.sessionIndex);
  throw new Error("Provide sessionId or sessionIndex.");
}
