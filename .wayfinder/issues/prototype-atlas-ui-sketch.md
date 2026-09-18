---
labels: [wayfinder:prototype]
status: closed
map: ../maps/conversation-atlas.md
resolved: 2026-08-06
assignee: trevor
asset: atlas-prototype/
---

## Question

What should the Conversation Atlas look and feel like in a throwaway prototype?

Build a rough interactive sketch (Canvas or local HTML) showing:
- Macro view with real data from a handful of your sessions
- Click-through into one conversation with at least one visible edit/resend branch
- Topic thread lanes or tags on the session card
- **LLM segmentation sample:** run LLM-per-conversation on 3–5 real chats; show actual segment boundaries + theme labels so we can judge quality/cost before full index

Goal: react to something concrete, not imagine it from prose.

## Resolution

Built throwaway prototype at `atlas-prototype/` — run with `npm run atlas-prototype` (http://localhost:3847).

Three UI variants (A/B/C) switchable via bottom bar or `?variant=`:
- **A — Theme columns** (preferred): theme-first home, segment slices, click-through to slice + expandable spine context
- **B — Timeline river**: recency-ordered sessions, color by primary theme
- **C — Split sidebar**: theme nav left, segments right

Sample: 7 real chats, hand-labeled LLM-style segments, MyPlace audit spine with pruned edit/resend branch demo.

**Verdict:** User approved — "looks great!" **Variant A** direction validated as home layout (theme columns, segment slices, spine drill-down).

## Next

Move from static sample data → real indexer reading `state.vscdb` + LLM segmentation pipeline.
