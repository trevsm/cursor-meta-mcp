import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { LocalAgentService } from "../../src/cursor-local.js";
import { createServer } from "../../src/server.js";

export async function withMcpClient<T>(
  service: LocalAgentService,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(service);
  await server.connect(serverTransport);

  const client = new Client({ name: "cursor-meta-test", version: "1.0.0" });
  await client.connect(clientTransport);

  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export async function callMetaTool(
  service: LocalAgentService,
  name: string,
  args: Record<string, unknown> = {},
) {
  return withMcpClient(service, async (client) => {
    await client.listTools();
    return client.callTool({ name, arguments: args });
  });
}
