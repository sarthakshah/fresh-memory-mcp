# Architecture

FreshMemory is a local, dependency-free Node.js MCP server. It separates memory lifecycle rules from source observation so each decision remains deterministic and testable.

## Components

### MCP server

`src/server.js` implements the JSON-RPC transport over standard input and output. It exposes tool definitions from `src/tools.js` and does not contain business rules.

### Tool layer

`src/tools.js` defines the MCP schemas and converts store results and domain errors into MCP tool responses.

### Memory store

`src/store.js` owns SQLite persistence and lifecycle rules:

- Memory creation and lexical recall
- Supersession and invalidation history
- Conflict detection
- Dependency impact propagation
- Tracked source state
- Pending source-change review

### Source reader

`src/source-reader.js` reads local sources and produces deterministic observations. JSON files return a selected value and rendered statement. Text files return only a fingerprint and byte count, preventing the server from pretending to understand prose.

### Command line

`src/cli.js` supports one-time and background source checks using the same store as the MCP server.

## Data model

`memories` stores immutable statement versions. A superseded row points to its replacement.

`dependencies` links decisions and assumptions to supporting memories. A dependent becomes reviewable when any upstream memory becomes stale, conflicted, superseded, or invalidated.

`tracked_sources` connects the current memory version to a local source and stores its approved fingerprint and value.

`source_changes` is an immutable change log. Changes move from `pending` to `applied` or `dismissed`.

Recall uses SQLite FTS5 when available and transparently falls back to indexed-table lexical matching when a platform's SQLite build omits FTS5.

## Source change flow

1. `track_source` verifies that the source baseline matches the existing memory.
2. `sync_sources` reads the source and compares its fingerprint with the approved baseline.
3. JSON `auto` mode renders the exact selected value and supersedes the memory.
4. JSON `review` mode and all text changes create pending records.
5. `resolve_source_change` accepts or dismisses a pending record.
6. When a source returns to its approved baseline, pending alerts for that source are dismissed automatically.

## Trust boundaries

- Version 0.2.2 performs no network requests.
- Source-file access is denied unless `FRESH_MEMORY_SOURCE_ROOTS` defines allowed locations.
- Files larger than 5 MB are rejected.
- Text content is not returned in change records.
- Existing memory remains active when a source cannot be checked.
- History is preserved for every applied source change.

## Adding external adapters

External sources should implement the same observation contract: a stable fingerprint, a safe structured value when available, and an optional exact statement. Each adapter must document authentication, rate limits, network destinations, and whether automatic application is safe.
