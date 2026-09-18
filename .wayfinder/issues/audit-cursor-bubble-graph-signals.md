---
labels: [wayfinder:research]
status: closed
map: ../maps/conversation-atlas.md
resolved: 2026-08-06
---

## Question

What conversation-graph signals exist in Cursor's local storage that could support edit/resend branches, topic threads, and cross-chat linking?

## Resolution

Research against live `state.vscdb` (~390k bubbles, ~1.7k sessions) and existing cursor-meta-mcp code.

### Edit-and-resend branches — **yes, deterministically**

Cursor stores two views:
1. **`composerData.fullConversationHeadersOnly`** — active sidebar chain
2. **`cursorDiskKV` `bubbleId:{sessionId}:*`** — superset including pruned bubbles

**Orphans** (in KV but not in headers) = pruned branches. Example: user edits prompt — orphan has same text stem, different `requestId`, earlier `createdAt`. Session `ce27e591` had 385 active headers vs 691 KV bubbles (306 orphan assistants from aborted regenerations).

Key fields: `type` (1=user, 2=assistant), `requestId`, `createdAt`, `grouping.textPreview` on headers.

`editTrailContexts` and `parentBubbleId` exist in schema but are **empty/null** in this dataset.

### Topic threads — **partially**

Deterministic: user turn boundaries (type-1 headers), time gaps, mode switches (`unifiedMode`), tool-profile shifts.

LLM needed: topic labels, semantic tangent detection, merging interleaved topics.

`subtitle` is first-message biased (matches user's complaint). `conversationMap` always `{}`.

### Cross-chat linking — **partially**

Strong native edges:
- **`subagentInfo.parentComposerId`** — 894 subagent sessions with explicit parent links
- **`subagentComposerIds[]`** on parent composers
- **`workspaceIdentifier` / `agentLocationHistory`** — workspace moves
- **`conversation-search.db`** FTS + `root_fingerprint`

No native thematic edges between unrelated sessions. Duplicate titles across workspaces are separate fingerprints (64 shared bubbleIds suggest workspace-move clones, not stored parent/child).

### Recommended data model

Build pipeline:
1. Ingest headers + composerData + all bubbles
2. Active chain from `fullConversationHeadersOnly`
3. Diff KV vs headers → `supersedes` / `aborted-response` edges
4. Subagent graph from `subagentInfo`
5. LLM overlay for topic clusters + cross-session similarity

Full report: research subagent [0482e9ed-48f7-46a3-a800-9d95ecbeef44](0482e9ed-48f7-46a3-a800-9d95ecbeef44).
