---
labels: [wayfinder:grilling]
status: closed
map: ../maps/conversation-atlas.md
resolved: 2026-08-06
---

## Question

What exactly is the destination artifact for the Conversation Atlas?

Pick the deliverable shape and success criteria so downstream tickets (navigation metaphor, UI prototype, indexing) have a fixed target.

Consider:
- **Standalone local web app** served by cursor-meta-mcp (like the orchestration dashboard)
- **Cursor Canvas** — rich React panel opened beside chat
- **Extension to existing dashboard** on the orchestration branch
- **Spec only** — architecture doc + data model, hand off implementation later
- **Something else**

Also nail v1 scope: read-only browse, or also "resume chat from branch"?

## Resolution

**Artifact:** Standalone local web app served by cursor-meta-mcp (dashboard-style).

**v1 scope:** Read-only — navigate, visualize, and search. No open-in-Cursor, no resume-from-branch, no manual tag editing in v1.

**Success criteria:** Can browse all local conversations visually, see topic threads and edit/resend branches inside a conversation, and find buried topics via categories/search — without leaving the atlas UI to act on them.
