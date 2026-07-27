# HumanLayer / CodeLayer alignment

Long-term direction for cursor-meta-mcp and agi-mode, informed by [HumanLayer](https://humanlayer.com), [CodeLayer](https://github.com/humanlayer/humanlayer), and [12-Factor Agents](https://github.com/humanlayer/12-factor-agents).

## Why this doc exists

HumanLayer's arc matches ours: **Gen 3 outer-loop agents** that run autonomously but **deterministically pause** for humans on high-stakes actions. CodeLayer adds **durable sessions**, **approval gates at the tool layer**, and **context engineering** (draft, fork, parallel worktrees).

We are not cloning CodeLayer. Cursor IDE + cursor-meta-mcp already provide history, MCP, and conductor chat. This doc maps their primitives to our stack and tracks what we build next.

## Concept mapping

| HumanLayer / CodeLayer | cursor-meta-mcp today | Target |
|------------------------|----------------------|--------|
| `hld` daemon + SQLite | Fleet manifest, checkpoints, `~/.cursor-meta/projects/` | Unified session store per project |
| Session ID (stable) + Run ID (per process) | `active-agi.json` sessionId/runId | ✅ v0.7 |
| Draft session (refine before spawn) | Conductor asks for task once | `meta_agi` with `draft: true` |
| Session fork | `meta_continue_from_chat` | Explicit fork from checkpoint tick |
| Approval gate (bash, write) | `meta_request_approval` | ✅ v0.7; worker hooks next |
| `human_as_tool` (advice, not yes/no) | `meta_request_approval` kind=feedback | ✅ v0.7 |
| YOLO / trusted mode | `humanGateMode: yolo` on architecture | ✅ v0.7 |
| SSE live session stream | Dashboard `/api/live` | Extend with approval events |
| MCP approval injection | user-cursor-meta MCP | Fleet worker approval MCP shim |
| OmniChannel (Slack, email) | Conductor chat (#1) | Optional webhooks later |
| Context engineering | Pulse + genome + learnings | Own context window per session file |
| 12-Factor #6 pause/resume | Stop/Start/Resume fleet | Already close; tie to runId |
| 12-Factor #7 contact humans via tools | `meta_request_approval` | ✅ v0.7 |
| 12-Factor #10 small focused agents | Honest loop, 1 SDK worker | Keep default |
| Outer loop agent | `meta_agi` + conductor | Primary UX |

## 12-Factor priorities for this repo

We adopt these as engineering law (not framework imports):

1. **Own your control flow** — fleet loops are our code (`sdk-worker`, watcher, strategy), not opaque framework graphs.
2. **Launch / pause / resume** — dashboard Stop/Start/Resume + checkpoint resume; approvals pause between tool intent and execution.
3. **Contact humans with tool calls** — structured `meta_request_approval`, not free-text "should I?" in chat only.
4. **Unify execution and business state** — one JSON ledger per project (`manifest`, `approvals`, `adaptations`, checkpoints).
5. **Small focused agents** — scale parallelism only after productive-tick gate passes.
6. **Own your context window** — `buildAgiWorkerPrompt` + pulse slice + git status; no unbounded history dumps.

## Human gate modes

| Mode | Behavior |
|------|----------|
| `strict` | All high/critical actions require approval before fleet proceeds |
| `standard` | Critical always; high-stakes when flagged by worker or conductor |
| `yolo` | Log only — CodeLayer-style trusted environment (dev laptops only) |

High-stakes patterns (initial set): force push, secret paths, fleet hard reset, architecture adaptation budget exhausted, production deploy keywords.

## Roadmap phases

### Phase A — Human gates (now)

- `meta_request_approval`, `meta_resolve_approval`, `meta_list_approvals`
- Session/run IDs on `meta_agi`
- `humanGateMode` on AGI architecture
- agi-mode skill: conductor resolves pending approvals from user messages

### Phase B — Worker integration

- SDK worker calls approval MCP before destructive shell/git
- Watcher blocks relaunch while critical approval pending
- Dashboard panel: pending approvals with approve/deny

### Phase C — Session product

- Draft mission (`meta_agi` draft) before fleet spawn
- Fork fleet from checkpoint tick (`meta_agi_fork`)
- SSE approval + tick events for external UIs

### Phase D — Channels (optional)

- Webhook adapter for Slack/email (HumanLayer-style routing)
- Idempotent approval delivery across channels

## Conductor contract (agi-mode)

When the user is the human-in-the-loop:

1. Check `meta_list_approvals` when resuming after idle or when user says yes/no.
2. Resolve with `meta_resolve_approval` — denial feedback is passed back to workers on next intercept.
3. Never bypass strict gates because the user typed quickly in chat; match approval id or idempotency key.
4. Agent-initiated contact is normal (Gen 3); do not treat it as failure.

## References

- [12-Factor Agents](https://github.com/humanlayer/12-factor-agents)
- [HumanLayer GitHub](https://github.com/humanlayer/humanlayer) (CodeLayer / hld / hlyr)
- [Factor 7: Contact humans with tool calls](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-07-contact-humans-with-tools.md)
- [The Outer Loop](https://theouterloop.substack.com) — agent-initiated human contact
