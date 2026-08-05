# cursor-meta-mcp

Local-only [Model Context Protocol](https://modelcontextprotocol.io/) server for Cursor. Lets an agent **browse your past Cursor chats**, **monitor active IDE conversations**, and **manually steer IDE chats or local SDK agents** on your machine — no cloud agents.

For autonomous orchestration (fleets, missions, pulse loops, AGI mode), use the [`orchestration`](./orchestration) branch.

## What it does

| Layer | Description |
|-------|-------------|
| **History** | List, search, show, and export past IDE chats from local SQLite |
| **Usage** | Per-chat token/cost totals from Cursor dashboard API (requires IDE login) |
| **Activity** | Detect recently active or in-flight IDE chats from composer state |
| **Steer IDE chats** | Abort generation (best effort) and send new messages via Agent CLI `--resume` |
| **Spawn** | Run local Cursor agents via `@cursor/sdk` or the Cursor Agent CLI |
| **Intercept SDK** | Cancel in-progress SDK runs and send steering follow-ups |
| **Continue** | Load a past chat as context, then start a new local agent |

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
| `meta_send_to_chat` | Headless follow-up via `agent --resume -p` (response in tool result, **not** sidebar) |
| `meta_abort_chat` | Best-effort stop for in-flight IDE generation |
| `meta_intercept_chat` | Abort + headless steering send (response in tool result, **not** sidebar) |
| `meta_create_chat` | Create a new empty chat and return its `composerId` |
| `meta_spawn_local_agent` | Start a headless local agent in a given `cwd` (no sidebar tab) |
| `meta_continue_from_chat` | Load past chat context + spawn a local agent |
| `meta_follow_up` | Send another prompt to an existing SDK agent |
| `meta_intercept_agent` | Cancel SDK run(s) + send a steering follow-up |
| `meta_list_local_agents` | List persisted local SDK agents |
| `meta_list_agent_runs` | List runs for one SDK agent |
| `meta_list_active_runs` | List in-progress local SDK runs |
| `meta_get_run` | Fetch run status/result |
| `meta_cancel_run` | Cancel an in-progress run |
| `meta_whoami` | Verify auth (API key or CLI login) |
| `meta_get_usage_period` | Current billing-cycle usage summary (IDE session token) |
| `meta_list_chat_usage` | Per-chat cost/token totals (included vs on-demand) for billing cycle or date range |
| `meta_rank_recent_chat_usage` | Rank N most recent local chats by cost (includes $0); splits included vs on-demand |
| `meta_chat_usage` | Usage breakdown for one chat (`sessionIndex` or `sessionId`) |
| `meta_chat_thinking` | Local chain-of-thought samples + tool stats (+ optional usage join) |
| `meta_chat_turns` | **Raw** per-turn chronological timeline: `thinking.text` + tool params/results (no scoring) |
| `meta_search_thinking` | **Fast** cross-chat search over literal `thinking.text` + **user prompts** (optional assistant); OR via `queries[]`, or `regex` |

Usage tools read `cursorAuth/accessToken` from local `state.vscdb` (same login as the Cursor IDE). They call `api2.cursor.sh` dashboard RPC and correlate `conversationId` with chat `composerId`.

`meta_chat_turns` with `turn=N` returns one turn’s full chain: thought → tool → assistant events in order, including tool `params` / `result`.

`meta_search_thinking` scans bubble JSON in `state.vscdb` (not FTS titles/bodies). Defaults to **thinking + user**. Example: `query: "StackOverflow"`, or `queries: ["confused","frustrated","going in circles"]`.

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
        "CURSOR_META_DEFAULT_MODEL": "composer-2.5-fast"
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
```

### Session indexes

- `meta_list_chats` returns **1-based** `sessionIndex` values (1 = most recent).
- Search results also include `sessionId` (UUID) for `meta_show_chat`.

## Auth modes

| Mode | Setup | Spawn behavior |
|------|-------|----------------|
| **CLI login** | `agent login` | One-shot runs via `agent -p --trust`; IDE chat send/intercept via `--resume` |
| **API key** | `CURSOR_API_KEY` in env | Full `@cursor/sdk` agents with persisted `agent-*` IDs, follow-up, and intercept |

History tools work without either.

## Orchestration branch

Autonomous features (`meta_mission`, `meta_self_improve`, pulse loops, fleet dashboard, AGI mode, etc.) live on the **`orchestration`** branch:

```bash
git checkout orchestration
npm install && npm run build
```

Point your MCP config at that checkout when you want the full orchestration stack.

## Development

```bash
npm run build
npm test
node scripts/test-mcp.mjs
```

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
- **IDE send is headless** — `meta_send_to_chat` runs `agent --resume -p` and returns the agent response in the tool result. It does **not** append messages to the Cursor sidebar transcript. Cloud agent chats (`bc-*`) require `force=true` and never update the sidebar.
- **No IDE tab control** — cannot focus or open a sidebar chat tab via MCP
- **Composer UUID ≠ SDK agent ID** — resume IDE chats by `sessionId`/`--resume`, SDK agents by `agentId`
- **Node version** — must match Cursor's MCP host (22.x); rebuild `better-sqlite3` after Node upgrades

## License

MIT
