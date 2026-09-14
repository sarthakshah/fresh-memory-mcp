import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

test("serves MCP initialize, tool listing, and tool calls over stdio", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-server-test-"));
  const databasePath = join(directory, "memory.sqlite");
  const sourcePath = join(directory, "campaign.json");
  writeFileSync(sourcePath, JSON.stringify({ budget: "$10,000" }));
  const executable = resolve("bin/fresh-memory-mcp.js");
  const child = spawn(process.execPath, [executable], {
    cwd: resolve("."),
    env: {
      ...process.env,
      FRESH_MEMORY_DB: databasePath,
      FRESH_MEMORY_SOURCE_ROOTS: directory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = new Map();
  const waiters = new Map();

  lines.on("line", (line) => {
    const response = JSON.parse(line);
    responses.set(response.id, response);
    waiters.get(response.id)?.(response);
  });

  const request = async (id, method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    if (responses.has(id)) {
      return responses.get(id);
    }
    return new Promise((resolveResponse, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 3000);
      waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolveResponse(response);
      });
    });
  };

  try {
    const initialize = await request(1, "initialize", { protocolVersion: "2025-06-18" });
    const tools = await request(2, "tools/list");
    const remembered = await request(3, "tools/call", {
      name: "remember",
      arguments: {
        type: "fact",
        key: "demo.budget",
        statement: "The demo budget is $10,000.",
      },
    });
    const recalled = await request(4, "tools/call", {
      name: "recall",
      arguments: { query: "demo budget" },
    });
    const tracked = await request(5, "tools/call", {
      name: "track_source",
      arguments: {
        memory_id: remembered.result.structuredContent.id,
        kind: "json_file",
        path: sourcePath,
        selector: "/budget",
        statement_template: "The demo budget is {{value}}.",
      },
    });
    writeFileSync(sourcePath, JSON.stringify({ budget: "$8,000" }));
    const synced = await request(6, "tools/call", {
      name: "sync_sources",
      arguments: { source_id: tracked.result.structuredContent.source.id },
    });
    const refreshed = await request(7, "tools/call", {
      name: "recall",
      arguments: { query: "demo budget" },
    });

    assert.equal(initialize.result.serverInfo.name, "fresh-memory-mcp");
    assert.equal(tools.result.tools.length, 11);
    assert.ok(tools.result.tools.some((tool) => tool.name === "track_source"));
    assert.ok(tools.result.tools.some((tool) => tool.name === "sync_sources"));
    assert.equal(remembered.result.isError, false);
    assert.equal(recalled.result.structuredContent.items.length, 1);
    assert.equal(
      recalled.result.structuredContent.items[0].statement,
      "The demo budget is $10,000.",
    );
    assert.equal(synced.result.structuredContent.results[0].action, "updated");
    assert.equal(
      refreshed.result.structuredContent.items[0].statement,
      "The demo budget is $8,000.",
    );
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    lines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
