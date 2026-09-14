import { createInterface } from "node:readline";
import { FreshMemoryStore } from "./store.js";
import { callTool, TOOL_DEFINITIONS } from "./tools.js";

const SERVER_VERSION = "0.2.2";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export async function runServer({ input = process.stdin, output = process.stdout } = {}) {
  const store = new FreshMemoryStore();
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });

  const close = () => {
    try {
      store.close();
    } catch {
      // The process may already be shutting down.
    }
  };

  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });

  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        writeMessage(output, rpcError(null, -32700, "Parse error"));
        continue;
      }

      const response = handleMessage(store, message);
      if (response) {
        writeMessage(output, response);
      }
    }
  } finally {
    close();
  }
}

export function handleMessage(store, message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, -32600, "Invalid Request");
  }

  const isNotification = message.id === undefined;

  switch (message.method) {
    case "initialize": {
      if (isNotification) {
        return null;
      }
      return rpcResult(message.id, {
        protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fresh-memory-mcp", version: SERVER_VERSION },
        instructions:
          "Store only durable, confirmed information. Link important facts to sources when possible. Sync tracked sources before relying on them, review pending changes, and surface freshness warnings rather than choosing silently.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : rpcResult(message.id, {});
    case "tools/list":
      return isNotification ? null : rpcResult(message.id, { tools: TOOL_DEFINITIONS });
    case "tools/call": {
      if (isNotification) {
        return null;
      }
      const name = message.params?.name;
      if (typeof name !== "string") {
        return rpcError(message.id, -32602, "Tool name is required.");
      }
      return rpcResult(
        message.id,
        callTool(store, name, message.params?.arguments ?? {}),
      );
    }
    default:
      return isNotification
        ? null
        : rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeMessage(output, message) {
  output.write(`${JSON.stringify(message)}\n`);
}
