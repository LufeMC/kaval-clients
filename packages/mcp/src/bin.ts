#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClientFromEnv, isMcpConfigError } from "./env.js";
import { createMcpServer } from "./server.js";

function formatFatalError(error: unknown): string {
  if (isMcpConfigError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  const client = createClientFromEnv();
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(formatFatalError(error));
  process.exit(1);
});
