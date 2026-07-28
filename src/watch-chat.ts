import { getChatActivity, type ChatActivity } from "./chat-activity.js";
import { getChatById, getChatByIndex } from "./history-store.js";
import { getIdeChatActivity, sendToIdeChat, type IdeChatActionResult } from "./ide-chat-control.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChatIdle(
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

export interface WatchChatParams {
  sessionIndex?: number;
  sessionId?: string;
  followUpPrompt?: string;
  cwd?: string;
  workspace?: string;
  mode?: "agent" | "plan" | "ask";
  model?: string;
  pollIntervalMs?: number;
  idleStableMs?: number;
  timeoutMs?: number;
  /** When true (default), send followUpPrompt even if the chat is already idle. */
  sendIfAlreadyIdle?: boolean;
}

export interface WatchChatResult {
  sessionId: string;
  sessionIndex?: number;
  watchedMs: number;
  wasAlreadyIdle: boolean;
  activityBefore: ChatActivity;
  activityAfter: ChatActivity;
  lastAssistantTail?: string;
  followUp?: IdeChatActionResult;
}

export function isChatActive(activity: ChatActivity): boolean {
  return activity.activityLevel === "active";
}

function resolveWatchSession(params: WatchChatParams): {
  sessionId: string;
  sessionIndex?: number;
  cwd: string;
} {
  if (params.sessionId) {
    const session = getChatById(params.sessionId);
    return {
      sessionId: params.sessionId,
      sessionIndex: params.sessionIndex,
      cwd: params.cwd ?? session.workspace,
    };
  }
  if (params.sessionIndex != null) {
    const session = getChatByIndex(params.sessionIndex);
    return {
      sessionId: session.id,
      sessionIndex: params.sessionIndex,
      cwd: params.cwd ?? session.workspace,
    };
  }
  throw new Error("Provide sessionId or sessionIndex.");
}

export function lastAssistantTail(
  sessionIndex?: number,
  sessionId?: string,
  maxChars = 600,
): string | undefined {
  const session = sessionId != null ? getChatById(sessionId) : getChatByIndex(sessionIndex!);
  const assistants = session.messages.filter((message) => message.role === "assistant");
  const last = assistants.at(-1);
  if (!last || typeof last.content !== "string" || !last.content.trim()) {
    return undefined;
  }
  const text = last.content.trim();
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

export async function watchIdeChat(params: WatchChatParams): Promise<WatchChatResult> {
  const started = Date.now();
  const { sessionId, sessionIndex, cwd } = resolveWatchSession(params);
  const activityBefore = getIdeChatActivity({ sessionId, sessionIndex });
  const sendIfAlreadyIdle = params.sendIfAlreadyIdle ?? true;
  const wasAlreadyIdle = !isChatActive(activityBefore);

  let activityAfter = activityBefore;
  if (wasAlreadyIdle) {
    if (params.followUpPrompt && sendIfAlreadyIdle) {
      const followUp = await sendToIdeChat({
        sessionId,
        prompt: params.followUpPrompt,
        cwd,
        workspace: params.workspace ?? cwd,
        mode: params.mode,
        model: params.model,
      });
      return {
        sessionId,
        sessionIndex: activityBefore.sessionIndex ?? sessionIndex,
        watchedMs: Date.now() - started,
        wasAlreadyIdle: true,
        activityBefore,
        activityAfter: getIdeChatActivity({ sessionId }),
        lastAssistantTail: lastAssistantTail(sessionIndex, sessionId),
        followUp,
      };
    }

    return {
      sessionId,
      sessionIndex: activityBefore.sessionIndex ?? sessionIndex,
      watchedMs: Date.now() - started,
      wasAlreadyIdle: true,
      activityBefore,
      activityAfter,
      lastAssistantTail: lastAssistantTail(sessionIndex, sessionId),
    };
  }

  activityAfter = await waitForChatIdle(sessionId, {
    pollIntervalMs: params.pollIntervalMs,
    idleStableMs: params.idleStableMs,
    timeoutMs: params.timeoutMs,
  });

  const result: WatchChatResult = {
    sessionId,
    sessionIndex: activityAfter.sessionIndex ?? sessionIndex,
    watchedMs: Date.now() - started,
    wasAlreadyIdle: false,
    activityBefore,
    activityAfter,
    lastAssistantTail: lastAssistantTail(sessionIndex, sessionId),
  };

  if (params.followUpPrompt) {
    result.followUp = await sendToIdeChat({
      sessionId,
      prompt: params.followUpPrompt,
      cwd,
      workspace: params.workspace ?? cwd,
      mode: params.mode,
      model: params.model,
    });
  }

  return result;
}
