# Design principles

How cursor-meta-mcp is meant to evolve — mapped to *A Philosophy of Software Design* (John Ousterhout) and our fleet operating constitution.

## North star

Build **persistent autonomous intelligence** that ships **verified diffs**, not plausible summaries — with **deterministic human gates** on high-stakes actions (HumanLayer / CodeLayer alignment). See [humanlayer-alignment.md](./humanlayer-alignment.md).

## Ousterhout principles we adopt

| Principle | In this repo |
|-----------|----------------|
| **Fight complexity** | One small change per tick; no architecture theater; freeze fleet surface area between sessions |
| **Deep modules, simple interfaces** | `tick-outcome`, `ground-truth`, `fleet-metrics`, `plan-budget` hide messy details behind small APIs |
| **Pull complexity downward** | Workers don't self-report success — git + `npm run test:fast` decide |
| **Define errors out of existence** | Preflight auth, budget gates, productive-tick gate block bad launches |
| **Strategic over tactical** | Operating constitution before scaling parallelism; archive sessions instead of losing history |

## Ousterhout tensions we accept (for now)

The **fleet layer** (watcher, strategy, pulse, world model, dashboard) adds systemic complexity. That is intentional research infrastructure — but it must not pretend to be product code. Keep it behind clear boundaries and shrink it when a simpler path works.

## Operating constitution (every tick)

From `src/genome.ts` — non-negotiable for SDK workers:

1. One small verified improvement only.
2. Run `npm run test:fast` before claiming success.
3. Git commit verified work; push when ahead of origin.
4. Never claim tests pass or done without ground truth this tick.
5. No architecture theater, meta-discussion, or user questions.

**Product vs meta:** Prefer ticks that change user-visible behavior (MCP tools, fleet control, docs). Meta/fleet work is allowed when metrics are red or preflight fails — not by default.

## Verification hierarchy

1. **Ground truth** — measured git + tests vs assistant claims (`ground-truth.ts`)
2. **Tick outcome** — commits, files, test counters (`tick-outcome.ts`)
3. **Fleet metrics** — productive ratio, stall detection (`fleet-metrics.ts`)
4. **Strategy review** — must respect SDK checkpoints, not IDE pulse alone
5. **Operator dashboard** — human overview first, technical details collapsed

## Complexity budget rules

- **No new supervisor type** until the previous one's actuators are wired (strategy `kill[]` → real SIGTERM, etc.).
- **No new log stream** without rotation and a single-line compact format; full state lives in `*-status.json`.
- **No regex sprawl** in ground truth without a structured tick report alternative on the roadmap.
- **Test-only ticks** capped: at most one narrow regression test per three feature ticks unless fixing a red gate.

## Session lifecycle

1. `npm run fleet:preflight` — auth, Node 22, budget, smoke checks
2. Launch — `honest-fleet` or dashboard relaunch
3. Run — SDK worker ticks until duration/max_ticks/error stop
4. Archive — checkpoint copied to `*.session-<timestamp>.json` before overwrite
5. Stop — `stopFleetProcesses`; overview shows last archived session

## Scoring a tick (design review)

| Question | Pass |
|----------|------|
| Does it reduce operator surprise? | Dashboard, archive, preflight, stable runtime clock |
| Does it deepen a module without widening callers? | New logic inside existing modules, not new parallel paths |
| Can we verify it without an LLM judge? | Tests, git, JSON metrics |
| Would Ousterhout call it tactical patching? | If yes, batch or reject unless unblocking the loop |

## References

- Operating constitution: `src/genome.ts`, `~/.cursor-meta/world/genome.md`
- Prior art and pitfalls: `docs/autonomous-fleet-research.md`
- Postmortem (July 2026): 27/27 productive SDK session after auth + ground-truth hardening
