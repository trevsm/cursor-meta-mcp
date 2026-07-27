# cursor-meta-mcp

Local-only [Model Context Protocol](https://modelcontextprotocol.io/) server for Cursor. Lets an agent **browse your past Cursor chats**, **monitor and steer active IDE conversations**, and **spawn or intercept local SDK agents** on your machine — no cloud agents.

## What it does

| Layer | Description |
|-------|-------------|
| **History** | List, search, show, and export past IDE chats from local SQLite |
| **Activity** | Detect recently active or in-flight IDE chats from composer state |
| **Steer IDE chats** | Abort generation (best effort) and send new messages via Agent CLI `--resume` |
| **Spawn** | Run local Cursor agents via `@cursor/sdk` or the Cursor Agent CLI |
| **Intercept SDK** | Cancel in-progress SDK runs and send steering follow-ups |
| **Continue** | Load a past chat as context, then start a new local agent |
| **Relentless loop** | Work → self-judge → retry until approved or max iterations |
| **Sentiment analysis** | Multi-axis frustration/confusion scoring over chat history |
| **Consciousness pulse** | Live scan for active chats, frustration risk, orchestration plays |
| **Auto-orchestrate** | Execute pulse WATCH/CONTINUE/INTERCEPT/SPAWN recommendations |
| **Mission** | One-call goal + success criteria → relentless loop until done |
| **Long session** | Wall-clock autonomous IDE chat: idle → follow-up → repeat with checkpoints |
| **Self-improve fleet** | One-call worker fleet + orchestrator + watcher + strategy reviewer for autonomous repo improvement |

All history reads stay on disk. Model calls still go through Cursor's API (local runtime, not Cursor cloud VMs).

## Tools

| Tool | Description |
|------|-------------|
| `meta_list_chats` | List past chats (1-based `sessionIndex`) |
| `meta_show_chat` | Full transcript by `sessionIndex` or `sessionId` |
| `meta_search_chats` | Full-text search via Cursor's `conversation-search.db` |
| `meta_export_chat` | Export a session as markdown or json |
| `meta_list_active_chats` | List recently active or in-flight IDE chats |
| `meta_get_chat_activity` | Inspect activity signals for one IDE chat |
| `meta_watch_chat` | Poll until idle, optionally send follow-up |
| `meta_send_to_chat` | Send a message to an IDE chat (`agent --resume`) |
| `meta_abort_chat` | Best-effort stop for in-flight IDE generation |
| `meta_intercept_chat` | Abort + send a steering message to an IDE chat |
| `meta_create_chat` | Create a new empty chat and return its `composerId` |
| `meta_spawn_local_agent` | Start a local agent in a given `cwd` |
| `meta_continue_from_chat` | Load past chat context + spawn a local agent |
| `meta_follow_up` | Send another prompt to an existing SDK agent |
| `meta_intercept_agent` | Cancel SDK run(s) + send a steering follow-up |
| `meta_list_local_agents` | List persisted local SDK agents |
| `meta_list_agent_runs` | List runs for one SDK agent |
| `meta_list_active_runs` | List in-progress local SDK runs |
| `meta_get_run` | Fetch run status/result |
| `meta_cancel_run` | Cancel an in-progress run |
| `meta_relentless_loop` | Self-critique loop: work → judge → retry until approved |
| `meta_sentiment_analysis` | Frustration/confusion/satisfaction scoring over chat history |
| `meta_consciousness_pulse` | Live orchestration scan with WATCH/INTERCEPT/CONTINUE recommendations |
| `meta_orchestrate_pulse` | Run pulse scan and auto-execute allowed orchestration plays |
| `meta_orchestrate_loop` | Repeat orchestrate pulse until idle or maxCycles |
| `meta_mission` | Goal + success criteria → worker/critic loop until approved |
| `meta_long_session` | Keep an IDE chat working for a duration (spawn + checkpoint by default) |
| `meta_self_improve` | Launch worker long-sessions + orchestrator + watcher + strategy reviewer (conductor excluded) |
| `meta_strategy_review` | Dimension-4 meta-critic: onTrack, pivot, spawn, kill from goal + transcript + git diff |
| `meta_whoami` | Verify auth (API key or CLI login) |

## Requirements

- **Node.js 22.x** for the MCP host (Cursor bundles Node 22; `better-sqlite3` must be built for it)
- **macOS** (history paths are tuned for Cursor's macOS layout)
- **Cursor IDE** with MCP support
- For spawn tools, one of:
  - `CURSOR_API_KEY` in the environment ([Dashboard → Integrations](https://cursor.com/dashboard/integrations)), or
  - Cursor Agent CLI logged in: `~/.local/bin/agent login`

## Install

```bash
git clone <repo-url>
cd cursor-meta-mcp
npm install

# Build native module for Node 22 (required for Cursor's MCP host)
npm rebuild better-sqlite3

npm run build
```

## Configure Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-meta": {
      "type": "stdio",
      "command": "/path/to/node22/bin/node",
      "args": ["/absolute/path/to/cursor-meta-mcp/dist/index.js"],
      "envFile": "${userHome}/.cursor/.env",
      "env": {
        "CURSOR_API_KEY": "${env:CURSOR_API_KEY}",
        "CURSOR_META_DEFAULT_MODEL": "composer-2.5"
      }
    }
  }
}
```

Optional secrets file `~/.cursor/.env`:

```bash
# CURSOR_API_KEY=cursor_...
```

Reload Cursor (`Cmd+Shift+P` → **Reload Window**), then enable **cursor-meta** under **Customize → MCP**.

## Usage in chat

**Start here** — one high-level call instead of picking tools:

```
Mission: add meta_mission with tests. Done when npm test passes and changes are committed.

Self-improve: stand up autonomous worker fleet on this repo for 2 hours — no user moves.
```

Ask in natural language — the agent picks tools automatically:

```
List my 10 most recent Cursor chats

Search my history for authentication refactor

Show me chat #3

Spawn a local agent in ~/Projects/my-app to summarize the README

Continue from chat #8 and finish the remaining todos

List active IDE chats and intercept chat #1 with "stop exploring, implement the MCP changes now"

Watch chat #3 until idle, then send "continue with the next step"

Cancel SDK run run-abc and steer agent agent-xyz to fix tests only

Relentless loop: fix all failing tests in this repo — keep going until you approve your own work

Run sentiment analysis on my chat history — show top frustrated messages and false-completion patterns
```

### Relentless self-critique loop

`meta_relentless_loop` implements **work → judge → retry**:

1. **Worker** runs the task (SDK agent or IDE chat via `--resume`).
2. **Critic** (separate read-only pass) scores the output as JSON: `{ approved, score, issues, nextPrompt }`.
3. If not approved, the worker gets `nextPrompt` and tries again — up to `maxIterations` (default 8).

**SDK mode** (default — best with `CURSOR_API_KEY` so the worker persists via `Agent.resume`):

```json
{
  "task": "Implement meta_watch_chat with tests",
  "cwd": "/Users/you/project",
  "maxIterations": 8,
  "approvalScore": 85
}
```

**IDE mode** (watch sidebar chat until idle between passes):

```json
{
  "task": "Continue sentiment analysis — add MCP tool",
  "cwd": "/Users/you/project",
  "target": "ide",
  "sessionIndex": 5,
  "idleStableMs": 3000
}
```

CLI runner (after `npm run build`):

```bash
node scripts/relentless-loop.mjs "Fix failing tests" /path/to/project
node scripts/relentless-loop.mjs --ide --session 5 "Continue work" /path/to/project
```

### Long-running IDE sessions

`meta_long_session` keeps an IDE chat working for a wall-clock duration: when idle, send a follow-up prompt; when busy, skip and retry. Checkpoints land under `~/.cursor-meta/long-sessions/` (or a custom `checkpointPath`).

**Prefer `spawn=true` (default)** so the driver detaches and survives MCP timeouts:

```json
{
  "cwd": "/Users/you/project",
  "sessionIndex": 2,
  "durationMs": 7200000,
  "tickIntervalMs": 60000,
  "prompt": "Keep improving autonomously. Verify with npm test."
}
```

Read progress later with `readCheckpoint: true` (same `checkpointPath` / session target).

CLI (after `npm run build`):

```bash
npm run long-session -- --session 2 --cwd /path/to/project --duration 2h
npm run long-session -- --session-id UUID --cwd . --duration 30m --prompt "Keep adding tests"
```

Busy and missing-session skips do not burn the consecutive-error budget (chat still working, or SQLite/CLI lag after create). Soft idle-wait timeouts do; hard failures stop immediately.

Optional knobs: `continueOnBusy` / `continueOnTimeout` (default true), `maxConsecutiveErrors` (default 8). Set `continueOnTimeout: false` to stop on the first idle-wait timeout.

### Self-improve fleet

`meta_self_improve` is the one-call autopilot: creates a dedicated worker IDE chat, attaches `meta_long_session` loops to chosen tabs, starts orchestrator + fleet watcher + **strategy reviewer (dimension 4)**, and injects pulse-aware prompts. The conductor session (default `#1`) is excluded from orchestration.

```json
{
  "cwd": "/Users/you/Projects/cursor-meta-mcp",
  "excludeSessionIndex": 1,
  "workerSessionIndexes": [2, 9],
  "durationMs": 7200000,
  "goal": "Autonomously improve this repo with verified npm test on every tick"
}
```

### Strategy review (dimension 4)

`meta_strategy_review` asks whether the fleet is working on the **right problem** — not just whether output is polished. It reads goal, transcript tail, `git diff --stat`, pulse signals, and worker checkpoints. Returns `{ onTrack, pivot, spawn, kill }`.

Heuristics always run (no API key needed). When `CURSOR_API_KEY` is set, an LLM critic merges with heuristics. The self-improve fleet runs this automatically every 5 minutes and intercepts workers when off-track.

CLI: `npm run strategy-review -- --cwd . --once`

### Fleet operations research

Prior art, pitfalls, and dead ends for autonomous self-improve fleets (local artifacts + industry postmortems): [`docs/autonomous-fleet-research.md`](docs/autonomous-fleet-research.md).

### Fleet dashboard

Local web UI for fleet visibility — budget, processes, live pulse, strategy review, and log tails:

```bash
npm run dashboard
# → http://127.0.0.1:3847
```

Reads `~/.cursor-meta/experiments/` and refreshes every 4 seconds. Options: `--port 3847`, `--workspace cursor-meta-mcp`, `--meta-dir ~/.cursor-meta`.

CLI: `npm run experiments` (uses `tsx` so source changes apply without rebuilding `dist/`).

### Session indexes

- `meta_list_chats` returns **1-based** `sessionIndex` values (1 = most recent).
- Search results also include `sessionId` (UUID) for `meta_show_chat`.

## Auth modes

| Mode | Setup | Spawn behavior |
|------|-------|----------------|
| **CLI login** | `agent login` | One-shot runs via `agent -p --trust`; IDE chat send/intercept via `--resume` |
| **API key** | `CURSOR_API_KEY` in env | Full `@cursor/sdk` agents with persisted `agent-*` IDs, follow-up, and intercept |

History tools work without either.

## Development

```bash
npm run build
npm test
node scripts/test-mcp.mjs
```

Long-session / experiment CLIs load TypeScript via `tsx` (`node --import tsx …`) so source changes apply without rebuilding `dist/` first. The MCP server entrypoint still uses `dist/` (`npm run build`).

Smoke-test via MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli --transport stdio --method tools/list \
  node dist/index.js
```

## Data sources

| Store | Purpose |
|-------|---------|
| `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | Chat headers + message bubbles |
| `.../globalStorage/conversation-search.db` | FTS search index |
| `composerHeaders` table | Session listing (sorted by recency) |

## Limitations

- **Unofficial** — reads Cursor's internal DB schema; may break on Cursor updates
- **macOS-first** — Linux/Windows paths not implemented yet
- **IDE abort is best-effort** — `meta_abort_chat` writes local composer state; in-flight runs may not stop instantly
- **IDE send uses Agent CLI** — requires `~/.local/bin/agent login`; messages go through CLI `--resume`, not the sidebar UI directly
- **No IDE tab control** — cannot focus or open a sidebar chat tab via MCP
- **Composer UUID ≠ SDK agent ID** — resume IDE chats by `sessionId`/`--resume`, SDK agents by `agentId`
- **Node version** — must match Cursor's MCP host (22.x); rebuild `better-sqlite3` after Node upgrades

## License

MIT
