import { FreshMemoryError, MEMORY_TYPES } from "./store.js";
import { SOURCE_KINDS, SOURCE_MODES } from "./source-reader.js";

export const TOOL_DEFINITIONS = [
  {
    name: "remember",
    description:
      "Store a durable fact, assumption, decision, preference, constraint, or observation with freshness metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["statement", "type"],
      properties: {
        statement: { type: "string", minLength: 1 },
        type: { type: "string", enum: MEMORY_TYPES },
        key: {
          type: "string",
          description: "Optional stable key. Multiple current memories with the same key and scope are conflicts.",
        },
        scope: { type: "string", default: "global" },
        source: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        valid_from: { type: "string", format: "date-time" },
        review_after: { type: ["string", "null"], format: "date-time" },
        expires_at: { type: ["string", "null"], format: "date-time" },
        depends_on: { type: "array", items: { type: "string" }, uniqueItems: true },
        tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: "recall",
    description:
      "Search memory. Returns only current, non-conflicted memories by default and reports relevant stale items as warnings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", default: "*" },
        scope: { type: "string" },
        include_stale: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
    },
  },
  {
    name: "supersede",
    description:
      "Replace a memory while preserving history. Dependents of the old memory will require review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["old_id", "statement"],
      properties: {
        old_id: { type: "string" },
        statement: { type: "string", minLength: 1 },
        reason: { type: "string" },
        type: { type: "string", enum: MEMORY_TYPES },
        key: { type: ["string", "null"] },
        scope: { type: "string" },
        source: { type: ["string", "null"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        valid_from: { type: "string", format: "date-time" },
        review_after: { type: ["string", "null"], format: "date-time" },
        expires_at: { type: ["string", "null"], format: "date-time" },
        depends_on: { type: "array", items: { type: "string" }, uniqueItems: true },
        tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: "invalidate",
    description:
      "Mark a memory invalid without deleting its history. Dependents will require review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "audit_memory",
    description:
      "List memories that are expired, superseded, invalidated, conflicted, or need review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
    },
  },
  {
    name: "explain_memory",
    description:
      "Explain a memory's state, history, dependencies, dependents, and replacement lineage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    },
  },
  {
    name: "track_source",
    description:
      "Link an active memory to a local JSON or text file and establish its current value as the baseline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["memory_id", "kind", "path"],
      properties: {
        memory_id: { type: "string" },
        kind: { type: "string", enum: SOURCE_KINDS },
        path: { type: "string" },
        selector: {
          type: "string",
          description: "Required for json_file. A JSON Pointer such as /campaign/budget.",
        },
        statement_template: {
          type: "string",
          description: "Required for json_file and must contain {{value}}.",
        },
        mode: { type: "string", enum: SOURCE_MODES },
        interval_seconds: { type: "integer", minimum: 5, maximum: 86400, default: 300 },
      },
    },
  },
  {
    name: "sync_sources",
    description:
      "Check tracked local sources now. Structured auto-mode changes replace memory; review-mode changes become pending.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_id: { type: "string" },
        due_only: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "review_changes",
    description: "List source changes waiting for human or agent review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
    },
  },
  {
    name: "resolve_source_change",
    description:
      "Accept or dismiss a pending source change. Text changes require a reviewed replacement statement when accepted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["change_id", "action"],
      properties: {
        change_id: { type: "string" },
        action: { type: "string", enum: ["accept", "dismiss"] },
        statement: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "watch_status",
    description:
      "Show tracked source health, overdue checks, errors, and pending changes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string" },
      },
    },
  },
];

export function callTool(store, name, argumentsObject = {}) {
  try {
    switch (name) {
      case "remember":
        return successfulResult(store.remember(argumentsObject));
      case "recall":
        return successfulResult(store.recall(argumentsObject));
      case "supersede":
        return successfulResult(store.supersede(argumentsObject));
      case "invalidate":
        return successfulResult(store.invalidate(argumentsObject));
      case "audit_memory":
        return successfulResult(store.audit(argumentsObject));
      case "explain_memory":
        return successfulResult(store.explain(argumentsObject));
      case "track_source":
        return successfulResult(store.trackSource(argumentsObject));
      case "sync_sources":
        return successfulResult(store.syncSources(argumentsObject));
      case "review_changes":
        return successfulResult(store.reviewChanges(argumentsObject));
      case "resolve_source_change":
        return successfulResult(store.resolveSourceChange(argumentsObject));
      case "watch_status":
        return successfulResult(store.watchStatus(argumentsObject));
      default:
        return errorResult(`Unknown tool: ${name}`, "METHOD_NOT_FOUND");
    }
  } catch (error) {
    if (error instanceof FreshMemoryError) {
      return errorResult(error.message, error.code);
    }
    return errorResult(error.message ?? "Unexpected error.", "INTERNAL_ERROR");
  }
}

function successfulResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function errorResult(message, code) {
  const value = { error: { code, message } };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}
