#!/usr/bin/env node

import { runServer } from "../src/server.js";
import { runCommand } from "../src/cli.js";

const argumentsList = process.argv.slice(2);
const VERSION = "0.2.2";

if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
  process.stdout.write(`fresh-memory-mcp ${VERSION}

Local MCP memory with automatic source freshness tracking.

Usage:
  fresh-memory-mcp                 Run the MCP server
  fresh-memory-mcp sync            Check all tracked sources now
  fresh-memory-mcp watch           Continuously check sources
  fresh-memory-mcp watch --poll 10 Check for due sources every 10 seconds
  fresh-memory-mcp status          Show source health
  fresh-memory-mcp changes         Show pending source changes

Environment:
  FRESH_MEMORY_DB            Optional SQLite database path
  FRESH_MEMORY_SOURCE_ROOTS  Required to track local source files
`);
  process.exit(0);
}

if (argumentsList.includes("--version") || argumentsList.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const operation = argumentsList.length === 0
  ? runServer()
  : runCommand(argumentsList);

operation.catch((error) => {
  process.stderr.write(`fresh-memory-mcp: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
