import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessIdeChatDelivery,
  assertIdeChatDeliveryAllowed,
  classifyChatSessionId,
  IdeChatDeliveryError,
  isCloudAgentId,
  isLocalComposerId,
} from "../src/chat-session.js";

const LOCAL_ID = "11111111-1111-1111-1111-111111111111";
const CLOUD_ID = "bc-488030cd-2431-4387-94d5-e47f0c83b625";

test("classifyChatSessionId distinguishes local and cloud ids", () => {
  assert.equal(classifyChatSessionId(LOCAL_ID), "local");
  assert.equal(classifyChatSessionId(CLOUD_ID), "cloud");
  assert.equal(classifyChatSessionId("not-an-id"), "unknown");
  assert.equal(isLocalComposerId(LOCAL_ID), true);
  assert.equal(isCloudAgentId(CLOUD_ID), true);
});

test("assessIdeChatDelivery marks cloud chats as headless-only", () => {
  const assessment = assessIdeChatDelivery(CLOUD_ID);
  assert.equal(assessment.sessionKind, "cloud");
  assert.equal(assessment.delivery.visibleInSidebar, false);
  assert.equal(assessment.delivery.mode, "headless_cli");
  assert.ok(assessment.warnings.some((entry) => entry.includes("Cloud agent")));
});

test("assertIdeChatDeliveryAllowed blocks cloud chats unless force", () => {
  const assessment = assessIdeChatDelivery(CLOUD_ID);
  assert.throws(
    () => assertIdeChatDeliveryAllowed(assessment),
    (error: unknown) => error instanceof IdeChatDeliveryError && /force=true/.test(error.message),
  );
  assert.doesNotThrow(() => assertIdeChatDeliveryAllowed(assessment, { force: true }));
});

test("assertIdeChatDeliveryAllowed rejects requireVisible", () => {
  const assessment = assessIdeChatDelivery(LOCAL_ID);
  assert.throws(
    () => assertIdeChatDeliveryAllowed(assessment, { requireVisible: true }),
    (error: unknown) => error instanceof IdeChatDeliveryError && /Sidebar-visible/.test(error.message),
  );
});

test("assessIdeChatDelivery adds activity warnings", () => {
  const assessment = assessIdeChatDelivery(LOCAL_ID, {
    sessionId: LOCAL_ID,
    title: "Active",
    workspace: process.cwd(),
    updatedAt: new Date().toISOString(),
    activityLevel: "active",
    generatingBubbleCount: 1,
    loadingToolCount: 1,
    hasBlockingPendingActions: true,
    signals: ["loading_tools"],
  });
  assert.ok(assessment.warnings.some((entry) => entry.includes("active")));
  assert.ok(assessment.warnings.some((entry) => entry.includes("Wait")));
});
