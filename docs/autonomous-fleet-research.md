# Autonomous fleet: prior art, pitfalls, and dead ends

Research snapshot for the cursor-meta self-improve fleet (July 2026). Use this before scaling workers, adding orchestration layers, or treating the world model as learned signal.

## TL;DR

Multi-agent coding orchestration is being tried everywhere (Gastown, Paperclip, Ralph loops, Claude agent teams). The pattern works as a **platform layer** when you have deterministic verification and bounded loops. It fails as **autonomous research** when:

- Workers spin without measurable outcomes (git diff + tests per tick)
- Production ledgers ingest test fixture data
- Duplicate fleets race the same IDE tabs
- The conductor chat does the commits while workers die on tick 1

**Fix telemetry and worker survival before adding parallelism.**

---

## Has this been tried?

### In this repo

| Phase | Shipped | Outcome |
|-------|---------|---------|
| v0.3–0.4 | IDE steering, relentless loop, mission | Reliable for single-session work |
| v0.5 | Long session + pulse orchestration | Detached ticks survive MCP timeout |
| v0.6 | Self-improve fleet, strategy review, budget governor | Architecture solid; operation lagged |
| Post-v0.6 | World model, dashboard, skill extraction | Memory layer existed but was fed test noise |

Observed in fleet artifacts (not code review alone):

- ~2 productive worker ticks across checkpoints in a 2.5h window; most commits came from conductor chats
- World-model episodes dominated by test fixture UUID `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
- Workers failed tick 1 with `Chat session not found` or hard-stopped on transient CLI errors
- Duplicate fleet generations (two orchestrators, manifest tracking only one)
- Strategy reviewer correctly flagged `stale_workers` and `fragmented_parallel_tabs` with no actuator wired to `kill[]`

Success likelihood (Conductor session assessment): **~75% platform layer**, **~40% full autonomous vision** until ground-truth loop closes.

### External prior art

| System | Model | Overlap with cursor-meta |
|--------|-------|--------------------------|
| [Gastown](https://github.com/steveyegge/gastown) | Mayor + worker polecats, git worktrees, hook-fired work, Witness patrol | Persistent work outside LLM session; self-heal on crash |
| [Paperclip](https://dev.to/jangwook_kim_e31e7291ad98/how-we-built-a-company-powered-by-14-ai-agents-using-paperclip-4bg6) | Org chart, heartbeats, task checkout | Budget + manifest + strategy reviewer |
| [cursor-agent-orchestrator-mcp](https://github.com/GustavoWinter/cursor-agent-orchestrator-mcp) | propose → confirm → execute, parallel SDK agents | Parallel spawn; adds human confirm gate |
| [mcp_coordinator](https://github.com/angrysky56/mcp_coordinator) | Skills, recursion, episodic persistence | World model + skill extraction |
| [self-improving-loop](https://github.com/azena-ai/self-improving-loop) / [Ralph](https://github.com/nileshteji/pi-ralph-lingum-loop) | genome.md + learnings.md + verify-before-ship | Simpler; often more reliable than multi-tab fleets |
| Claude Code agent teams | Overnight multi-agent runs | [12 coordination bugs in one cycle](https://github.com/anthropics/claude-code/issues/54393) |

Industry write-ups converge on three structural bottlenecks ([analysis](https://ice-ice-bear.github.io/posts/2026-04-16-multiagent-orchestration/), [pipeline postmortem](https://dibi8.com/resources/llm-frameworks/multi-agent-pipeline-postmortem-5-failures-2026/)):

1. **Context collapse** — goal drift across handoffs
2. **Ghost delegation** — tasks appear running but produce nothing
3. **Verification error** — plausible summaries accepted without ground truth

---

## Pitfalls (observed locally)

| Pitfall | Symptom | Mitigation |
|---------|---------|------------|
| Test pollution of ledger | Episodes/budget count `npm test` as real ticks | `CURSOR_META_HOME` per test run; `meta-home.ts` centralizes paths |
| Hardcoded state paths | Tests write to `~/.cursor-meta` | Route all writes through `metaHome()` / `metaPath()` |
| No singleton fleet lock | Two orchestrators, double billing | `process-lock.ts` on launch roles |
| Session binding fragility | Worker dies on missing chat UUID | `rebindOnMissing` in long-session |
| Tick ledger without outcomes | Can't tell improving from spinning | `tick-outcome.ts`: git shortstat + `test:fast` |
| Node version mismatch | Pulse fails: `better-sqlite3` vs host Node | Use Node 22 for CLI; `npm rebuild better-sqlite3` |
| Truncated MCP tool surface | Fleet tools missing in some hosts | CLI fallbacks: `npm run pulse`, `experiments`, etc. |
| Strategy without actuation | Reviewer flags issues; nothing kills PIDs | Wire `kill[]` → `stopFleetProcesses` |
| Meta-discussion loops | High message count, zero commits | Strategy codes: `meta_discussion_loop`, `architecture_theater` |
| False completion | Assistant claims done; user frustrated | Sentiment + tick-level git/test gates |

---

## Dead ends (avoid)

1. **More parallel tabs before ground-truth works** — multiplies dead processes, not throughput.
2. **Deep agent hierarchies (5+ roles)** — coordination tax dominates past ~3–4 agents; one instrumented worker often beats a buggy fleet.
3. **LLM-only verification** — self-critique without `git diff` + test exit codes creates false confidence.
4. **Persistent memory without test isolation** — poisons world model, budget, and strategy inputs.
5. **Orchestrator-only polling** — work should propel via tick loop + checkpoints, not wait on 60s pulse cycles alone.
6. **Approval-prompt shims** — fix CLI allowlist once instead of runtime wrapper scripts.
7. **Conductor-as-worker** — session #1 researches and steers; workers ship verified diffs.
8. **Compaction without rehydration** — long-session checkpoints must be read on worker wake (Claude Code BUG-1 pattern).

---

## What's working (keep)

- History, pulse, intercept, detached long-session driver
- Strategy heuristics and issue codes map to real failures
- Soft-skip semantics (busy/missing don't burn error budget)
- Git-sync policy in self-improve prompts
- Dashboard with live PID checks and relaunch
- Fresh-session + disk memory pattern (world model, skills) — aligns with Ralph/genome loops when fed real signal

---

## Recommended operating order

| Priority | Action | Falsifiable check |
|----------|--------|-------------------|
| 1 | Land telemetry + isolation WIP | Episodes use real composer UUIDs, not fixture |
| 2 | One worker, one lock, one manifest | 10 ticks with `outcome.producedWork=true` |
| 3 | Act on strategy `kill[]` | Stale PIDs actually stopped |
| 4 | Git worktree per worker | Safe parallelism (Gastown pattern) |
| 5 | Promote failures → skills / lessons | Repeated failures don't recur |
| 6 | Node 22 for all SQLite CLI | `npm run pulse` succeeds |

**Fleet success criterion:** ≥30% of ticks show `producedWork=true`; ≥1 worker commit/hour sustained over 2h — not conductor commits.

---

## References

- [Why Multi-Agent Orchestration Doesn't Work Well](https://ice-ice-bear.github.io/posts/2026-04-16-multiagent-orchestration/)
- [Multi-Agent Pipeline Postmortem (5 failures)](https://dibi8.com/resources/llm-frameworks/multi-agent-pipeline-postmortem-5-failures-2026/)
- [Claude Code overnight coordination postmortem](https://github.com/anthropics/claude-code/issues/54393)
- [Gastown deep dive](https://trilogyai.substack.com/p/deep-dive-gastown)
- [Self-improving loop (genome pattern)](https://github.com/azena-ai/self-improving-loop)
- [Reflection: completion verification layer](https://www.vibebrowser.app/blog/reflection-verification-layer)
