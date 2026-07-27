# cursor-meta-mcp

Local-only [Model Context Protocol](https://modelcontextprotocol.io/) server for Cursor. Lets an agent **browse your past Cursor chats** and **spawn local agents** on your machine — no cloud agents.

## What it does

| Layer | Description |
|-------|-------------|
| **History** | List, search, show, and export past IDE chats from local SQLite |
| **Spawn** | Run local Cursor agents via `@cursor/sdk` or the Cursor Agent CLI |
| **Continue** | Load a past chat as context, then start a new local agent |

All history reads stay on disk. Model calls still go through Cursor's API (local runtime, not Cursor cloud VMs).

## Tools

| Tool | Description |
|------|-------------|
| `meta_list_chats` | List past chats (1-based `sessionIndex`) |
| `meta_show_chat` | Full transcript by `sessionIndex` or `sessionId` |
| `meta_search_chats` | Full-text search via Cursor's `conversation-search.db` |
| `meta_export_chat` | Export a session as markdown or json |
| `meta_spawn_local_agent` | Start a local agent in a given `cwd` |
| `meta_continue_from_chat` | Load past chat context + spawn a local agent |
| `meta_follow_up` | Send another prompt to an existing SDK agent |
| `meta_list_local_agents` | List persisted local SDK agents |
| `meta_get_run` | Fetch run status/result |
| `meta_cancel_run` | Cancel an in-progress run |
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

Ask in natural language — the agent picks tools automatically:

```
List my 10 most recent Cursor chats

Search my history for authentication refactor

Show me chat #3

Spawn a local agent in ~/Projects/my-app to summarize the README

Continue from chat #8 and finish the remaining todos
```

### Session indexes

- `meta_list_chats` returns **1-based** `sessionIndex` values (1 = most recent).
- Search results also include `sessionId` (UUID) for `meta_show_chat`.

## Auth modes

| Mode | Setup | Spawn behavior |
|------|-------|----------------|
| **CLI login** | `agent login` | One-shot runs via `agent -p --trust` |
| **API key** | `CURSOR_API_KEY` in env | Full `@cursor/sdk` agents with persisted `agent-*` IDs and `meta_follow_up` |

History tools work without either.

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
- **No IDE tab control** — cannot open a new sidebar chat tab via MCP
- **Composer UUID ≠ SDK agent ID** — resume IDE chats by seeding context, not by UUID
- **Node version** — must match Cursor's MCP host (22.x); rebuild `better-sqlite3` after Node upgrades

## License

MIT
