#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, loadConfig } from './app.js';

/**
 * `inlet-mcp`: the Inlet MCP server (PRD sections 8.11 and 20.1).
 *
 * Speaks MCP over stdio, so an agent runs it as a subprocess. It authenticates with a
 * secret server key and therefore acts with project Admin authority inside exactly one
 * project (FR-120). Per-user MCP is outside the MVP.
 *
 * Configure it with two environment variables:
 *
 *   INLET_URL        the deployment, e.g. https://inlet.example.com
 *   INLET_SECRET_KEY a secret server key (isk_…)
 */
try {
  const config = loadConfig(process.env);
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
} catch (error) {
  // stderr, never stdout: stdout is the MCP transport.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
