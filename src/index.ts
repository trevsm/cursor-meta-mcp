#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CursorLocalService } from "./cursor-local.js";
import { createServer } from "./server.js";
import { FLEET_AGENT_MODEL } from "./fleet-model.js";

async function main(): Promise<void> {
  const service = new CursorLocalService({
    apiKey: process.env.CURSOR_API_KEY,
    defaultModel: FLEET_AGENT_MODEL,
  });

  const server = createServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[cursor-meta-mcp] Local-only server running on stdio.");
  if (!process.env.CURSOR_API_KEY) {
    console.error(
      "[cursor-meta-mcp] Warning: CURSOR_API_KEY is not set. Spawn/follow-up tools will fail until configured.",
    );
  }
}

main().catch((error) => {
  console.error("[cursor-meta-mcp] Fatal error:", error);
  process.exit(1);
});
