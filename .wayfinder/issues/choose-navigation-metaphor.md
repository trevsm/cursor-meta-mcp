---
labels: [wayfinder:grilling]
status: closed
map: ../maps/conversation-atlas.md
resolved: 2026-08-06
assignee: trevor
---

## Question

What is the primary navigation metaphor for the Conversation Atlas?

Once the destination artifact is pinned, choose how users browse at each zoom level:

**Macro (all conversations)**
- Force-directed graph of sessions linked by subagent edges / AI similarity
- Timeline / calendar swimlanes by workspace
- Card grid with AI category clusters
- Hybrid: categories as columns, recency within each

**Meso (one conversation)**
- Linear timeline with branch forks (edit/resend) peeling off
- Topic-thread lanes (parallel swimlanes when conversation pivots)
- Node graph where tangents become disconnected subgraphs

**Micro (one turn)**
- Existing `meta_chat_turns` timeline (thought → tool → assistant)

Which combination matches how you actually hunt for old conversations?

## Resolution

**Core model: spine + overlay** — not timeline *or* categories. Two coexisting layers:
- **Spine:** chronological turns in a conversation, including edit/resend branch forks
- **Overlay:** AI-detected **thread segments** (turn ranges), each tagged with one or more themes

**Grouping unit:** the **segment**, not the whole conversation. One chat can have multiple themes; one theme can span multiple chats.

### Zoom levels

| Level | View | Purpose |
|-------|------|---------|
| **Macro (home)** | Theme-first index | "What have I been working on?" — AI-proposed theme clusters with segment previews, conversation count, last activity |
| **Theme drill-down** | Cross-chat timeline of matching **segments only** | Find buried work across conversations |
| **Conversation drill-down** | Linear spine, colored segments, branch forks | See full story of one chat |
| **Micro** | `meta_chat_turns` timeline | Deep dive on one turn |

**Not chosen for v1 home:** force-directed session graph (too noisy at ~1.7k sessions), pure timeline home (doesn't surface cross-chat work), repo-grouped flat list (current Cursor sidebar problem).

### Segment display in theme view

**Default: slice only (A)** — show just the relevant turns for that theme. One click to expand surrounding context from the same conversation.

### Session cards (any list)

Show **multiple theme chips** per conversation (not first-message preview alone). Fixes buried-topic visibility at a glance.

### Priority

**Visibility first** — theme-first home optimized for finding work, spine preserved as faithful drill-down.
