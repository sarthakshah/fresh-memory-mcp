# FreshMemory MCP

AI memory that checks whether it is still true.

[![CI](https://github.com/sarthakshah/fresh-memory-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sarthakshah/fresh-memory-mcp/actions/workflows/ci.yml)

FreshMemory is a local Model Context Protocol server that links important memories to their original sources. It detects source changes, preserves revision history, and flags decisions that relied on outdated information.

## The problem

Most memory systems optimize recall. They can retrieve an old budget, a new budget, and a decision based on the old budget without explaining which one should still be trusted.

FreshMemory adds deterministic lifecycle rules:

- Structured source changes can automatically replace outdated memories.
- Unstructured document changes wait for review instead of being guessed.
- Dependents of changed information require review.
- Expired information is excluded by default.
- Duplicate current keys are surfaced as conflicts.
- History remains inspectable in a local SQLite database.

## Requirements

- Node.js 22.13 or newer
- No API key
- No hosted service
- No runtime dependencies

Current version: `0.2.2` — GitHub-only public beta.

FreshMemory is distributed from GitHub for public testing. The local behavior is tested on Node.js 22.13 and 24. It has not been published to npm, and npm publishing remains intentionally blocked.

Use sample or non-sensitive data while evaluating the beta. See the [testing guide](docs/TESTING.md) for safe setup, practical scenarios, and feedback instructions.

## Try the demo

```bash
npm run demo
```

The demo tracks a campaign budget in a JSON file. When the budget changes from `$50,000` to `$35,000`, FreshMemory automatically supersedes the old memory and marks a paid-search allocation based on the old budget as needing review.

## Run locally

```bash
npm test
npm start
```

To install the command locally:

```bash
npm install -g .
fresh-memory-mcp --version
```

Register the installed command with Codex:

```bash
codex mcp add fresh-memory \
  --env FRESH_MEMORY_DB=/absolute/path/to/fresh-memory.sqlite \
  --env FRESH_MEMORY_SOURCE_ROOTS=/absolute/path/to/allowed/files \
  -- fresh-memory-mcp
```

The default database location is platform-specific. Set `FRESH_MEMORY_DB` to use an explicit path.

## Connect an assistant

### Codex

```toml
[mcp_servers.fresh-memory]
command = "fresh-memory-mcp"

[mcp_servers.fresh-memory.env]
FRESH_MEMORY_DB = "/absolute/path/to/fresh-memory.sqlite"
FRESH_MEMORY_SOURCE_ROOTS = "/absolute/path/to/files:/another/allowed/path"
```

### Claude Desktop

```json
{
  "mcpServers": {
    "fresh-memory": {
      "command": "fresh-memory-mcp",
      "env": {
        "FRESH_MEMORY_DB": "/absolute/path/to/fresh-memory.sqlite",
        "FRESH_MEMORY_SOURCE_ROOTS": "/absolute/path/to/files"
      }
    }
  }
}
```

`FRESH_MEMORY_SOURCE_ROOTS` is required only for `track_source` and source-sync features. Without it, FreshMemory can still store and recall memories, but it refuses to read any source file. Use `:` between allowed directories on macOS and Linux, and `;` on Windows.

## Automatic freshness workflow

1. Store a durable memory with `remember`.
2. Link it to a local file with `track_source`.
3. Run `sync_sources`, or keep `fresh-memory-mcp watch` running.
4. Exact JSON changes automatically create a replacement memory in `auto` mode.
5. Text and review-mode changes appear in `review_changes`.
6. Accept or dismiss a pending change with `resolve_source_change`.
7. Use `watch_status` to find errors, overdue checks, and pending changes.

### Structured JSON example

Given this file:

```json
{
  "campaign": {
    "budget": "$50,000"
  }
}
```

Track the memory using:

```json
{
  "memory_id": "MEMORY_ID",
  "kind": "json_file",
  "path": "/absolute/path/to/campaign.json",
  "selector": "/campaign/budget",
  "statement_template": "The campaign budget is {{value}}.",
  "mode": "auto",
  "interval_seconds": 300
}
```

The selector is a JSON Pointer. Exact structured values are safe to render from the statement template without asking a model to interpret the document.

### Text document example

Text files always use `review` mode. FreshMemory detects that the file changed but does not claim to understand the new policy. An assistant or person must review the document and provide the replacement statement.

## Background commands

```bash
fresh-memory-mcp sync
fresh-memory-mcp status
fresh-memory-mcp changes
fresh-memory-mcp watch
fresh-memory-mcp watch --poll 10
```

The watcher polls for sources whose individual `interval_seconds` has elapsed. It stays quiet when nothing changes and prints only meaningful changes or errors.

## MCP tools

| Tool | Purpose |
|---|---|
| `remember` | Store durable information with freshness metadata |
| `recall` | Search current memory and report relevant warnings |
| `supersede` | Replace a memory while preserving history |
| `invalidate` | Mark a memory unusable without deleting it |
| `audit_memory` | Find expired, conflicted, or reviewable memories |
| `explain_memory` | Show state, history, dependencies, dependents, and tracked sources |
| `track_source` | Link an active memory to a local JSON or text file |
| `sync_sources` | Check tracked sources and apply safe changes |
| `review_changes` | List source changes waiting for review |
| `resolve_source_change` | Accept or dismiss a pending source change |
| `watch_status` | Report source health, errors, overdue checks, and pending changes |

## Safety model

| Situation | Behavior |
|---|---|
| Exact JSON value changed in `auto` mode | Supersede the old memory automatically |
| JSON value changed in `review` mode | Create a pending change |
| Text file changed | Create a pending change |
| Source disappeared or became invalid | Report a source error; keep existing memory |
| No source roots are configured | Refuse to read or track source files |
| Source is outside configured roots | Reject it |
| Two active memories share a key and scope | Mark both as conflicted |

FreshMemory never uses an LLM inside the server, never silently interprets prose, and never deletes history when a source changes.

## Recommended agent behavior

Tell your assistant:

> Store only durable, confirmed information. Link important facts to their original sources when possible. Sync tracked sources before relying on them. Automatically accept only exact structured changes. Review ambiguous changes and surface freshness warnings rather than guessing.

## Memory model

Every memory can include:

- `type`: `fact`, `assumption`, `decision`, `preference`, `constraint`, or `observation`
- `statement`: human-readable information
- `key`: stable identifier used for conflict detection
- `scope`: project, client, or domain boundary
- `source`: where the information came from
- `confidence`: value from `0` to `1`
- `valid_from`, `review_after`, and `expires_at`
- `depends_on`: memory IDs supporting this memory
- `tags` and JSON metadata

Default review periods are 30 days for assumptions, 90 days for constraints, 180 days for facts and decisions, and 365 days for preferences. Observations do not receive a default review date. Pass `review_after: null` to disable the default.

## Current limitations

- Version 0.2 watches local JSON and text files only.
- External APIs, databases, web pages, and SaaS connectors are not included yet.
- JSON selectors use JSON Pointer rather than JSONPath.
- Search is lexical rather than embedding-based.
- Team synchronization and access controls are not included.
- The assistant must call the MCP tools; FreshMemory cannot override untracked conversation context.

These constraints keep automatic updates local, explainable, safe, and easy to test.

## Project documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Release process](docs/RELEASING.md)
- [Private tester guide](docs/TESTING.md)
- [Changelog](CHANGELOG.md)

## License

FreshMemory is available under the [MIT License](LICENSE).
