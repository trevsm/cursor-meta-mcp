import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import type { ChatActivity } from "./chat-activity.js";

const LOCAL_COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUD_AGENT_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatSessionKind = "local" | "cloud" | "unknown";

export type IdeChatDeliveryMode = "headless_cli";

export interface IdeChatDeliveryInfo {
  mode: IdeChatDeliveryMode;
  visibleInSidebar: false;
  note: string;
}

export interface IdeChatDeliveryAssessment {
  sessionId: string;
  sessionKind: ChatSessionKind;
  hasLocalStorage: boolean;
  delivery: IdeChatDeliveryInfo;
  warnings: string[];
  blockers: string[];
}

function globalDbPath(): string {
  return (
    process.env.CURSOR_META_STATE_DB ??
    join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
  );
}

export function isCloudAgentId(sessionId: string): boolean {
  return CLOUD_AGENT_ID.test(sessionId);
}

export function isLocalComposerId(sessionId: string): boolean {
  return LOCAL_COMPOSER_ID.test(sessionId);
}

export function classifyChatSessionId(sessionId: string): ChatSessionKind {
  if (isCloudAgentId(sessionId)) return "cloud";
  if (isLocalComposerId(sessionId)) return "local";
  return "unknown";
}

export function hasLocalComposerStorage(sessionId: string): boolean {
  try {
    const db = new Database(globalDbPath(), { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT 1 FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${sessionId}`);
      return row != null;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

const HEADLESS_DELIVERY_NOTE =
  "Uses `agent --resume -p` (headless CLI). The agent response is returned in the tool result only — it does not append to the Cursor sidebar transcript.";

export function assessIdeChatDelivery(
  sessionId: string,
  activity?: ChatActivity,
): IdeChatDeliveryAssessment {
  const sessionKind = classifyChatSessionId(sessionId);
  const hasLocalStorage =
    sessionKind === "local" ? hasLocalComposerStorage(sessionId) : false;

  const warnings: string[] = [];
  const blockers: string[] = [];

  if (sessionKind === "cloud") {
    warnings.push(
      "Cloud agent chat (bc-*). Sidebar state is synced from Cursor cloud, not local SQLite.",
    );
  } else if (sessionKind === "local" && !hasLocalStorage) {
    warnings.push("Local composer id has no composerData in SQLite yet (chat may be new or archived).");
  } else if (sessionKind === "unknown") {
    warnings.push("Unrecognized session id format.");
  }

  if (activity) {
    if (activity.activityLevel === "active") {
      warnings.push(
        `Chat appears active (${activity.signals.join(", ") || "in flight"}). Consider meta_intercept_chat with abortFirst to steer.`,
      );
    }
    if (activity.hasBlockingPendingActions) {
      warnings.push("Chat has blocking pending actions in composer headers.");
    }
    if (activity.loadingToolCount > 0) {
      warnings.push(
        `Chat has ${activity.loadingToolCount} in-flight tool call(s) (e.g. Wait). Headless send runs in parallel and will not cancel them.`,
      );
    }
  }

  return {
    sessionId,
    sessionKind,
    hasLocalStorage,
    delivery: {
      mode: "headless_cli",
      visibleInSidebar: false,
      note: HEADLESS_DELIVERY_NOTE,
    },
    warnings,
    blockers,
  };
}

export class IdeChatDeliveryError extends Error {
  readonly assessment: IdeChatDeliveryAssessment;

  constructor(message: string, assessment: IdeChatDeliveryAssessment) {
    super(message);
    this.name = "IdeChatDeliveryError";
    this.assessment = assessment;
  }
}

export function assertIdeChatDeliveryAllowed(
  assessment: IdeChatDeliveryAssessment,
  opts: { requireVisible?: boolean; force?: boolean } = {},
): void {
  if (opts.requireVisible) {
    throw new IdeChatDeliveryError(
      "Sidebar-visible delivery is not supported. MCP sends via headless `agent --resume -p`; responses appear in the tool result, not the IDE chat UI. Use requireVisible=false (default) or meta_continue_from_chat for a new headless run.",
      assessment,
    );
  }

  if (opts.force) return;

  if (assessment.sessionKind === "cloud") {
    throw new IdeChatDeliveryError(
      "Cloud agent chats (bc-*) cannot update the IDE sidebar via MCP. Pass force=true to run headless and receive the response in this tool result only.",
      assessment,
    );
  }
}
