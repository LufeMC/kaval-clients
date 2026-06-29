#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClientFromEnv } from "./env.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const client = createClientFromEnv();
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
