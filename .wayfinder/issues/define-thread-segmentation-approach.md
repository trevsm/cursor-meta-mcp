---
labels: [wayfinder:grilling]
status: closed
map: ../maps/conversation-atlas.md
resolved: 2026-08-06
assignee: trevor
---

## Question

How should topic threads be detected and labeled within a conversation?

Options to weigh:
- **Heuristic only** — split on user turns + time gaps + mode/tool shifts (fast, no API cost, misses semantic pivots)
- **LLM per conversation** — agent reads transcript, emits topic clusters with turn ranges (accurate, costs tokens, needs refresh strategy)
- **Hybrid** — heuristics propose segment boundaries, LLM labels each segment
- **User-assisted** — AI proposes, you confirm/merge/split

Also: should buried topics surface as **tags on the session card** (fixing the "first message only" preview problem)?

## Resolution

**Approach: LLM per conversation.** Each session gets one LLM pass that reads the transcript and emits:
- Thread **segments** (turn ranges)
- **Theme labels** per segment (used for cross-chat grouping and session-card chips)

**Validate before scaling:** run on a handful of real conversations first — see output quality, cost, and latency before indexing full history (~1.7k sessions). Prototype ticket should include this sample run.

**Session cards:** yes — surface **multiple theme chips** from LLM segments (not first-message preview alone).

**Deferred (fog):** refresh strategy (re-index on conversation update vs manual refresh), user correction of mislabeled segments (out of v1 read-only scope).
