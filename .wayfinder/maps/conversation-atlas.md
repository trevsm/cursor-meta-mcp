---
labels: [wayfinder:map]
status: open
---

# Conversation Atlas

## Destination

A **visual conversation atlas** — a browsable UI (fed by cursor-meta MCP) that lets you see, categorize, and traverse your full Cursor chat history. Per conversation: topic threads and edit/resend branches rendered as navigable graphs, not a flat repo-grouped list. Cross-conversation: AI-derived categories plus search so buried topics are findable.

## Notes

- **Domain:** cursor-meta-mcp + local Cursor storage (`state.vscdb`, `conversation-search.db`)
- **Skills:** `/wayfinder`, `/prototype`, `/canvas` (for visual deliverables), cursor-meta MCP tools
- **Standing prefs:** macOS local-only first; build on existing MCP read APIs; deterministic graph signals before LLM overlays
- **Tracker:** local markdown (`.wayfinder/`). Child issues live in `.wayfinder/issues/`. Blocking via `blocked_by` frontmatter. Frontier = open + unblocked + unassigned.

## Decisions so far

<!-- one line per closed ticket -->

- [Audit Cursor bubble graph signals](../issues/audit-cursor-bubble-graph-signals.md) — Branches recoverable via KV⊃headers diff + `requestId`; subagent edges native; topics/categories need LLM overlay
- [Pin the destination](../issues/pin-the-destination.md) — Standalone local web app (cursor-meta-mcp); v1 read-only browse/search/visualize
- [Choose navigation metaphor](../issues/choose-navigation-metaphor.md) — Theme-first home; spine+overlay model; segments as grouping unit; slice-only default in theme view
- [Define thread segmentation approach](../issues/define-thread-segmentation-approach.md) — LLM per conversation for segments + theme labels; validate on sample before full index; theme chips on session cards
- [Prototype atlas UI sketch](../issues/prototype-atlas-ui-sketch.md) — Variant A (theme columns) validated; slice + spine drill-down approved

## Not yet specified

- Indexing refresh strategy (on update vs manual vs background batch)
- **Inbox UX:** Active strip at top — live summary per card, click title to open, **Finish** auto-files via AI (no manual theme pick)
- Click-through behavior (open chat in Cursor sidebar vs read-only atlas view)
- Cloud agent (`bc-*`) inclusion — local SQLite may not cover these
- Performance budget for full-history indexing (~1.7k sessions observed)
- Whether duplicate sessions (workspace-move clones) should merge or stay separate

## Out of scope

- Replacing Cursor's native sidebar entirely — this complements it
- Real-time IDE co-editing of chats — read/navigate only for v1
