import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FreshMemoryError } from "./errors.js";
import {
  inspectSource,
  normalizeSourcePath,
  normalizeSourceRoots,
  parseSourceRoots,
  SOURCE_KINDS,
  SOURCE_MODES,
} from "./source-reader.js";

export { FreshMemoryError } from "./errors.js";

export const MEMORY_TYPES = [
  "fact",
  "assumption",
  "decision",
  "preference",
  "constraint",
  "observation",
];

const BASE_STATES = ["active", "superseded", "invalidated"];
const DEFAULT_REVIEW_DAYS = {
  fact: 180,
  assumption: 30,
  decision: 180,
  preference: 365,
  constraint: 90,
  observation: null,
};

export function defaultDatabasePath(environment = process.env) {
  if (environment.FRESH_MEMORY_DB) {
    return resolve(environment.FRESH_MEMORY_DB);
  }

  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "fresh-memory",
      "fresh-memory.sqlite",
    );
  }

  if (platform() === "win32") {
    const applicationData = environment.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(applicationData, "fresh-memory", "fresh-memory.sqlite");
  }

  const dataDirectory = environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataDirectory, "fresh-memory", "fresh-memory.sqlite");
}

export class FreshMemoryStore {
  constructor({
    databasePath = defaultDatabasePath(),
    now = () => new Date(),
    sourceRoots = parseSourceRoots(),
    maxSourceBytes,
    enableFullTextSearch = true,
  } = {}) {
    this.databasePath = databasePath;
    this.now = now;
    this.sourceRoots = normalizeSourceRoots(sourceRoots);
    this.maxSourceBytes = maxSourceBytes;
    this.enableFullTextSearch = enableFullTextSearch;
    this.fullTextSearchEnabled = false;

    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:") {
      this.database.exec("PRAGMA journal_mode = WAL");
    }
    this.initializeSchema();
  }

  initializeSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        memory_key TEXT,
        type TEXT NOT NULL CHECK (type IN (${MEMORY_TYPES.map((type) => `'${type}'`).join(", ")})),
        statement TEXT NOT NULL,
        scope TEXT NOT NULL,
        source TEXT,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        base_state TEXT NOT NULL CHECK (base_state IN (${BASE_STATES.map((state) => `'${state}'`).join(", ")})),
        valid_from TEXT NOT NULL,
        review_after TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_by TEXT REFERENCES memories(id),
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope);
      CREATE INDEX IF NOT EXISTS memories_key_idx ON memories(scope, memory_key);
      CREATE INDEX IF NOT EXISTS memories_state_idx ON memories(base_state);

      CREATE TABLE IF NOT EXISTS dependencies (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        depends_on_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        PRIMARY KEY (memory_id, depends_on_id),
        CHECK (memory_id <> depends_on_id)
      );

      CREATE INDEX IF NOT EXISTS dependencies_parent_idx ON dependencies(depends_on_id);

      CREATE TABLE IF NOT EXISTS tags (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracked_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id),
        kind TEXT NOT NULL CHECK (kind IN (${SOURCE_KINDS.map((kind) => `'${kind}'`).join(", ")})),
        path TEXT NOT NULL,
        selector TEXT,
        statement_template TEXT,
        mode TEXT NOT NULL CHECK (mode IN (${SOURCE_MODES.map((mode) => `'${mode}'`).join(", ")})),
        interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 5),
        last_fingerprint TEXT NOT NULL,
        last_value_json TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        last_changed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('healthy', 'changed', 'error')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tracked_sources_memory_idx ON tracked_sources(memory_id);
      CREATE INDEX IF NOT EXISTS tracked_sources_status_idx ON tracked_sources(status);

      CREATE TABLE IF NOT EXISTS source_changes (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES tracked_sources(id) ON DELETE CASCADE,
        old_memory_id TEXT NOT NULL REFERENCES memories(id),
        observed_fingerprint TEXT NOT NULL,
        previous_value_json TEXT NOT NULL,
        observed_value_json TEXT NOT NULL,
        proposed_statement TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'dismissed')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_reason TEXT,
        replacement_memory_id TEXT REFERENCES memories(id)
      );

      CREATE INDEX IF NOT EXISTS source_changes_source_idx ON source_changes(source_id);
      CREATE INDEX IF NOT EXISTS source_changes_state_idx ON source_changes(state);
      CREATE UNIQUE INDEX IF NOT EXISTS source_changes_pending_idx
        ON source_changes(source_id, observed_fingerprint)
        WHERE state = 'pending';
    `);

    if (this.enableFullTextSearch) {
      const searchTableExists = Boolean(
        this.database
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'")
          .get(),
      );
      try {
        this.database.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            memory_id UNINDEXED,
            statement,
            memory_key,
            scope,
            source,
            tags,
            tokenize = 'unicode61'
          );
        `);
        this.fullTextSearchEnabled = true;
        if (!searchTableExists) {
          const memoryIds = this.database.prepare("SELECT id FROM memories").all();
          for (const { id } of memoryIds) {
            this.syncSearchRow(id);
          }
        }
      } catch (error) {
        if (!/no such module: fts5/i.test(error.message ?? "")) {
          throw error;
        }
      }
    }
  }

  remember(input) {
    return this.transaction(() => this.insertMemory(input));
  }

  insertMemory(input) {
    const currentTime = this.currentIsoTime();
    const type = requiredEnum(input.type, "type", MEMORY_TYPES);
    const statement = requiredString(input.statement, "statement");
    const memoryKey = optionalString(input.key, "key");
    const scope = optionalString(input.scope, "scope") ?? "global";
    const source = optionalString(input.source, "source");
    const confidence = normalizeConfidence(input.confidence);
    const validFrom = normalizeDate(input.valid_from, "valid_from") ?? currentTime;
    const reviewAfter = Object.hasOwn(input, "review_after")
      ? normalizeDate(input.review_after, "review_after")
      : addDays(currentTime, DEFAULT_REVIEW_DAYS[type]);
    const expiresAt = normalizeDate(input.expires_at, "expires_at");
    const metadata = normalizeMetadata(input.metadata);
    const dependencies = normalizeStringList(input.depends_on, "depends_on");
    const tags = normalizeStringList(input.tags, "tags");
    const id = optionalString(input.id, "id") ?? randomUUID();

    if (expiresAt && Date.parse(expiresAt) <= Date.parse(validFrom)) {
      throw new FreshMemoryError("expires_at must be later than valid_from");
    }

    this.assertDependenciesExist(dependencies);

    this.database
      .prepare(`
        INSERT INTO memories (
          id, memory_key, type, statement, scope, source, confidence, base_state,
          valid_from, review_after, expires_at, created_at, updated_at,
          superseded_by, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?)
      `)
      .run(
        id,
        memoryKey,
        type,
        statement,
        scope,
        source,
        confidence,
        validFrom,
        reviewAfter,
        expiresAt,
        currentTime,
        currentTime,
        JSON.stringify(metadata),
      );

    const dependencyStatement = this.database.prepare(
      "INSERT INTO dependencies (memory_id, depends_on_id) VALUES (?, ?)",
    );
    for (const dependencyId of dependencies) {
      dependencyStatement.run(id, dependencyId);
    }

    const tagStatement = this.database.prepare(
      "INSERT INTO tags (memory_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) {
      tagStatement.run(id, tag);
    }

    this.recordEvent(id, "created", { type, scope, key: memoryKey });
    this.syncSearchRow(id);
    return this.getMemory(id);
  }

  recall({ query = "*", scope, include_stale = false, limit = 10 } = {}) {
    const normalizedLimit = normalizeLimit(limit);
    const normalizedScope = optionalString(scope, "scope");
    const rows = this.searchRows(query, normalizedScope, Math.max(normalizedLimit * 5, 50));
    const memories = rows.map((row) => this.hydrateMemory(row));

    if (include_stale) {
      return {
        query,
        scope: normalizedScope ?? null,
        items: memories.slice(0, normalizedLimit),
        warnings: [],
        summary: `${Math.min(memories.length, normalizedLimit)} memories returned, including non-current states.`,
      };
    }

    const items = memories
      .filter((memory) => memory.status === "active")
      .slice(0, normalizedLimit);
    const warnings = memories
      .filter((memory) => memory.status !== "active")
      .slice(0, normalizedLimit)
      .map(compactWarning);

    return {
      query,
      scope: normalizedScope ?? null,
      items,
      warnings,
      summary:
        warnings.length === 0
          ? `${items.length} current memories returned.`
          : `${items.length} current memories returned; ${warnings.length} relevant memories require attention.`,
    };
  }

  supersede(input) {
    const oldId = requiredString(input.old_id, "old_id");
    const oldMemory = this.getMemory(oldId);
    if (oldMemory.base_state !== "active") {
      throw new FreshMemoryError(
        `Memory ${oldId} cannot be superseded because it is ${oldMemory.base_state}.`,
        "INVALID_STATE",
      );
    }

    return this.transaction(() => {
      const replacementInput = {
        statement: requiredString(input.statement, "statement"),
        type: input.type ?? oldMemory.type,
        key: Object.hasOwn(input, "key") ? input.key : oldMemory.key,
        scope: input.scope ?? oldMemory.scope,
        source: Object.hasOwn(input, "source") ? input.source : oldMemory.source,
        confidence: input.confidence ?? oldMemory.confidence,
        valid_from: input.valid_from,
        expires_at: input.expires_at,
        depends_on: input.depends_on ?? oldMemory.depends_on,
        tags: input.tags ?? oldMemory.tags,
        metadata: input.metadata ?? oldMemory.metadata,
      };
      if (Object.hasOwn(input, "review_after")) {
        replacementInput.review_after = input.review_after;
      }
      const replacement = this.insertMemory(replacementInput);
      const currentTime = this.currentIsoTime();

      this.database
        .prepare(`
          UPDATE memories
          SET base_state = 'superseded', superseded_by = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(replacement.id, currentTime, oldId);

      this.recordEvent(oldId, "superseded", {
        replacement_id: replacement.id,
        reason: optionalString(input.reason, "reason"),
      });
      this.recordEvent(replacement.id, "supersedes", { previous_id: oldId });

      return {
        previous: this.getMemory(oldId),
        replacement: this.getMemory(replacement.id),
        affected_dependents: this.getDependentIds(oldId),
      };
    });
  }

  invalidate({ id, reason } = {}) {
    const memoryId = requiredString(id, "id");
    const normalizedReason = optionalString(reason, "reason") ?? "Invalidated by user or agent.";
    const memory = this.getMemory(memoryId);

    if (memory.base_state === "superseded") {
      throw new FreshMemoryError(
        `Memory ${memoryId} is already superseded and cannot be invalidated.`,
        "INVALID_STATE",
      );
    }

    if (memory.base_state === "invalidated") {
      return {
        memory,
        affected_dependents: this.getDependentIds(memoryId),
        already_invalidated: true,
      };
    }

    return this.transaction(() => {
      this.database
        .prepare("UPDATE memories SET base_state = 'invalidated', updated_at = ? WHERE id = ?")
        .run(this.currentIsoTime(), memoryId);
      this.recordEvent(memoryId, "invalidated", { reason: normalizedReason });

      return {
        memory: this.getMemory(memoryId),
        affected_dependents: this.getDependentIds(memoryId),
        already_invalidated: false,
      };
    });
  }

  audit({ scope, limit = 100 } = {}) {
    const normalizedScope = optionalString(scope, "scope");
    const normalizedLimit = normalizeLimit(limit, 500);
    const parameters = [];
    let whereClause = "";

    if (normalizedScope) {
      whereClause = "WHERE scope IN (?, 'global')";
      parameters.push(normalizedScope);
    }

    const rows = this.database
      .prepare(`SELECT * FROM memories ${whereClause} ORDER BY updated_at DESC LIMIT ?`)
      .all(...parameters, normalizedLimit);
    const memories = rows.map((row) => this.hydrateMemory(row));
    const groups = {};

    for (const memory of memories) {
      if (memory.status === "active") {
        continue;
      }
      groups[memory.status] ??= [];
      groups[memory.status].push(compactWarning(memory));
    }

    return {
      scope: normalizedScope ?? null,
      checked: memories.length,
      attention_count: Object.values(groups).reduce((total, group) => total + group.length, 0),
      groups,
    };
  }

  explain({ id } = {}) {
    const memoryId = requiredString(id, "id");
    const memory = this.getMemory(memoryId);
    const dependencies = memory.depends_on.map((dependencyId) => this.getMemory(dependencyId));
    const dependents = this.getDependentIds(memoryId).map((dependentId) => this.getMemory(dependentId));
    const predecessors = this.database
      .prepare("SELECT id FROM memories WHERE superseded_by = ? ORDER BY updated_at ASC")
      .all(memoryId)
      .map((row) => this.getMemory(row.id));
    const replacement = memory.superseded_by ? this.getMemory(memory.superseded_by) : null;
    const events = this.database
      .prepare("SELECT event_type, details_json, created_at FROM events WHERE memory_id = ? ORDER BY id ASC")
      .all(memoryId)
      .map((event) => ({
        type: event.event_type,
        details: JSON.parse(event.details_json),
        created_at: event.created_at,
      }));

    return {
      memory,
      dependencies,
      dependents,
      predecessors,
      replacement,
      events,
      tracked_sources: this.listSourcesForMemory(memoryId),
    };
  }

  trackSource(input) {
    const memoryId = requiredString(input.memory_id, "memory_id");
    const memory = this.getMemory(memoryId);
    if (memory.base_state !== "active") {
      throw new FreshMemoryError(
        `Memory ${memoryId} cannot be tracked because it is ${memory.base_state}.`,
        "INVALID_STATE",
      );
    }

    const kind = requiredEnum(input.kind, "kind", SOURCE_KINDS);
    const mode = optionalString(input.mode, "mode") ?? (kind === "json_file" ? "auto" : "review");
    if (!SOURCE_MODES.includes(mode)) {
      throw new FreshMemoryError(`mode must be one of: ${SOURCE_MODES.join(", ")}.`);
    }
    if (kind === "text_file" && mode === "auto") {
      throw new FreshMemoryError("text_file sources must use review mode.");
    }

    const selector = kind === "json_file" ? requiredString(input.selector, "selector") : null;
    const statementTemplate = kind === "json_file"
      ? requiredString(input.statement_template, "statement_template")
      : null;
    const intervalSeconds = normalizeInteger(
      input.interval_seconds ?? 300,
      "interval_seconds",
      5,
      86_400,
    );
    const path = normalizeSourcePath(input.path, this.sourceRoots);
    const sourceInput = {
      kind,
      path,
      selector,
      statement_template: statementTemplate,
    };
    const observation = inspectSource(sourceInput, this.sourceOptions());
    if (kind === "json_file" && observation.proposed_statement !== memory.statement) {
      throw new FreshMemoryError(
        `Tracked source baseline renders as "${observation.proposed_statement}" but the memory says "${memory.statement}".`,
        "SOURCE_BASELINE_MISMATCH",
      );
    }
    const currentTime = this.currentIsoTime();
    const id = randomUUID();

    this.database
      .prepare(`
        INSERT INTO tracked_sources (
          id, memory_id, kind, path, selector, statement_template, mode,
          interval_seconds, last_fingerprint, last_value_json, last_checked_at,
          last_changed_at, status, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'healthy', NULL, ?, ?)
      `)
      .run(
        id,
        memoryId,
        kind,
        observation.path,
        selector,
        statementTemplate,
        mode,
        intervalSeconds,
        observation.fingerprint,
        JSON.stringify(observation.value),
        currentTime,
        currentTime,
        currentTime,
      );

    return {
      source: this.getTrackedSource(id),
      baseline: {
        value: observation.value,
        proposed_statement: observation.proposed_statement,
      },
    };
  }

  syncSources({ source_id: sourceId, due_only: dueOnly = false } = {}) {
    const normalizedSourceId = optionalString(sourceId, "source_id");
    let rows = normalizedSourceId
      ? this.database.prepare("SELECT * FROM tracked_sources WHERE id = ?").all(normalizedSourceId)
      : this.database.prepare("SELECT * FROM tracked_sources ORDER BY created_at ASC").all();

    if (normalizedSourceId && rows.length === 0) {
      throw new FreshMemoryError(`Tracked source ${normalizedSourceId} was not found.`, "NOT_FOUND");
    }

    if (dueOnly && !normalizedSourceId) {
      const currentTime = this.now().getTime();
      rows = rows.filter(
        (row) => Date.parse(row.last_checked_at) + row.interval_seconds * 1000 <= currentTime,
      );
    }

    const results = rows.map((row) => {
      try {
        return this.syncSource(this.hydrateSource(row));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const currentTime = this.currentIsoTime();
        this.database
          .prepare(`
            UPDATE tracked_sources
            SET last_checked_at = ?, status = 'error', last_error = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(currentTime, message, currentTime, row.id);
        return {
          source_id: row.id,
          action: "error",
          error: message,
        };
      }
    });
    return {
      checked: results.length,
      changed: results.filter((result) =>
        ["updated", "pending", "reverted"].includes(result.action)).length,
      errors: results.filter((result) => result.action === "error").length,
      results,
    };
  }

  reviewChanges({ scope, limit = 100 } = {}) {
    const normalizedScope = optionalString(scope, "scope");
    const normalizedLimit = normalizeLimit(limit, 500);
    const scopeClause = normalizedScope ? "AND m.scope IN (?, 'global')" : "";
    const parameters = normalizedScope ? [normalizedScope] : [];
    const rows = this.database
      .prepare(`
        SELECT c.*
        FROM source_changes c
        JOIN tracked_sources s ON s.id = c.source_id
        JOIN memories m ON m.id = s.memory_id
        WHERE c.state = 'pending' ${scopeClause}
        ORDER BY c.created_at ASC
        LIMIT ?
      `)
      .all(...parameters, normalizedLimit);

    return {
      scope: normalizedScope ?? null,
      pending_count: rows.length,
      changes: rows.map((row) => this.hydrateSourceChange(row)),
    };
  }

  resolveSourceChange(input) {
    const changeId = requiredString(input.change_id, "change_id");
    const action = requiredEnum(input.action, "action", ["accept", "dismiss"]);
    const row = this.database.prepare("SELECT * FROM source_changes WHERE id = ?").get(changeId);
    if (!row) {
      throw new FreshMemoryError(`Source change ${changeId} was not found.`, "NOT_FOUND");
    }
    if (row.state !== "pending") {
      throw new FreshMemoryError(
        `Source change ${changeId} is already ${row.state}.`,
        "INVALID_STATE",
      );
    }

    const source = this.getTrackedSource(row.source_id);
    const currentTime = this.currentIsoTime();
    const reason = optionalString(input.reason, "reason");
    if (action === "dismiss") {
      this.transaction(() => {
        this.database
          .prepare(`
            UPDATE source_changes
            SET state = 'dismissed', resolved_at = ?, resolution_reason = ?
            WHERE id = ?
          `)
          .run(currentTime, reason, changeId);
        this.advanceSourceBaseline(source.id, row, currentTime);
      });
      return {
        action: "dismissed",
        change: this.getSourceChange(changeId),
        source: this.getTrackedSource(source.id),
      };
    }

    const statement = optionalString(input.statement, "statement") ?? row.proposed_statement;
    if (!statement) {
      throw new FreshMemoryError(
        "statement is required when accepting a text file change.",
      );
    }
    const memory = this.currentSourceMemory(source);
    const replacement = this.supersede({
      old_id: memory.id,
      statement,
      reason: reason ?? `Accepted change detected in ${source.path}.`,
    });

    this.transaction(() => {
      this.database
        .prepare(`
          UPDATE source_changes
          SET state = 'applied', resolved_at = ?, resolution_reason = ?, replacement_memory_id = ?
          WHERE id = ?
        `)
        .run(currentTime, reason, replacement.replacement.id, changeId);
      this.advanceSourceBaseline(source.id, row, currentTime, replacement.replacement.id);
    });

    return {
      action: "updated",
      change: this.getSourceChange(changeId),
      replacement,
      source: this.getTrackedSource(source.id),
    };
  }

  watchStatus({ scope } = {}) {
    const normalizedScope = optionalString(scope, "scope");
    const scopeClause = normalizedScope ? "WHERE m.scope IN (?, 'global')" : "";
    const parameters = normalizedScope ? [normalizedScope] : [];
    const rows = this.database
      .prepare(`
        SELECT s.*
        FROM tracked_sources s
        JOIN memories m ON m.id = s.memory_id
        ${scopeClause}
        ORDER BY s.created_at ASC
      `)
      .all(...parameters);
    const sources = rows.map((row) => {
      const source = this.hydrateSource(row);
      const dueAt = new Date(
        Date.parse(source.last_checked_at) + source.interval_seconds * 1000,
      ).toISOString();
      const pending = this.database
        .prepare("SELECT COUNT(*) AS count FROM source_changes WHERE source_id = ? AND state = 'pending'")
        .get(source.id).count;
      return {
        ...source,
        health: source.status === "healthy" && Date.parse(dueAt) <= this.now().getTime()
          ? "overdue"
          : source.status,
        due_at: dueAt,
        pending_changes: pending,
      };
    });

    return {
      scope: normalizedScope ?? null,
      source_count: sources.length,
      attention_count: sources.filter((source) => source.health !== "healthy").length,
      sources,
    };
  }

  syncSource(source) {
    const currentTime = this.currentIsoTime();
    let observation;
    try {
      observation = inspectSource(source, this.sourceOptions());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database
        .prepare(`
          UPDATE tracked_sources
          SET last_checked_at = ?, status = 'error', last_error = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(currentTime, message, currentTime, source.id);
      return {
        source_id: source.id,
        action: "error",
        error: message,
      };
    }

    if (observation.fingerprint === source.last_fingerprint) {
      const revertedChanges = this.database
        .prepare(`
          UPDATE source_changes
          SET state = 'dismissed', resolved_at = ?,
              resolution_reason = 'Source returned to the approved baseline.'
          WHERE source_id = ? AND state = 'pending'
        `)
        .run(currentTime, source.id).changes;
      this.database
        .prepare(`
          UPDATE tracked_sources
          SET last_checked_at = ?, status = 'healthy', last_error = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(currentTime, currentTime, source.id);
      return {
        source_id: source.id,
        action: revertedChanges > 0 ? "reverted" : "unchanged",
        memory_id: source.memory_id,
        resolved_changes: revertedChanges,
      };
    }

    const existingChange = this.database
      .prepare(`
        SELECT * FROM source_changes
        WHERE source_id = ? AND observed_fingerprint = ? AND state = 'pending'
      `)
      .get(source.id, observation.fingerprint);
    if (existingChange) {
      this.markSourceChanged(source.id, currentTime);
      return {
        source_id: source.id,
        action: "pending",
        change: this.hydrateSourceChange(existingChange),
        duplicate: true,
      };
    }

    const memory = this.currentSourceMemory(source);
    if (source.mode === "auto") {
      const replacement = this.supersede({
        old_id: memory.id,
        statement: observation.proposed_statement,
        reason: `Automatically detected change in ${source.path}.`,
      });
      const changeId = randomUUID();
      this.transaction(() => {
        this.insertSourceChange({
          id: changeId,
          sourceId: source.id,
          oldMemoryId: memory.id,
          previousValue: source.last_value,
          observation,
          state: "applied",
          resolvedAt: currentTime,
          resolutionReason: "Automatically applied from a structured source.",
          replacementMemoryId: replacement.replacement.id,
        });
        this.advanceSourceObservation(
          source.id,
          observation,
          currentTime,
          replacement.replacement.id,
        );
      });
      return {
        source_id: source.id,
        action: "updated",
        change: this.getSourceChange(changeId),
        replacement,
      };
    }

    const changeId = randomUUID();
    this.transaction(() => {
      this.insertSourceChange({
        id: changeId,
        sourceId: source.id,
        oldMemoryId: memory.id,
        previousValue: source.last_value,
        observation,
        state: "pending",
      });
      this.markSourceChanged(source.id, currentTime);
    });
    return {
      source_id: source.id,
      action: "pending",
      change: this.getSourceChange(changeId),
      duplicate: false,
    };
  }

  currentSourceMemory(source) {
    let memory = this.getMemory(source.memory_id);
    while (memory.base_state === "superseded" && memory.superseded_by) {
      memory = this.getMemory(memory.superseded_by);
    }
    if (memory.id !== source.memory_id) {
      this.database
        .prepare("UPDATE tracked_sources SET memory_id = ?, updated_at = ? WHERE id = ?")
        .run(memory.id, this.currentIsoTime(), source.id);
    }
    if (memory.base_state !== "active") {
      throw new FreshMemoryError(
        `Tracked memory ${memory.id} is ${memory.base_state}.`,
        "INVALID_STATE",
      );
    }
    return memory;
  }

  insertSourceChange({
    id,
    sourceId,
    oldMemoryId,
    previousValue,
    observation,
    state,
    resolvedAt = null,
    resolutionReason = null,
    replacementMemoryId = null,
  }) {
    this.database
      .prepare(`
        INSERT INTO source_changes (
          id, source_id, old_memory_id, observed_fingerprint, previous_value_json,
          observed_value_json, proposed_statement, state, created_at, resolved_at,
          resolution_reason, replacement_memory_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        sourceId,
        oldMemoryId,
        observation.fingerprint,
        JSON.stringify(previousValue),
        JSON.stringify(observation.value),
        observation.proposed_statement,
        state,
        this.currentIsoTime(),
        resolvedAt,
        resolutionReason,
        replacementMemoryId,
      );
  }

  advanceSourceObservation(sourceId, observation, currentTime, memoryId) {
    this.database
      .prepare(`
        UPDATE tracked_sources
        SET memory_id = ?, last_fingerprint = ?, last_value_json = ?,
            last_checked_at = ?, last_changed_at = ?, status = 'healthy',
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(
        memoryId,
        observation.fingerprint,
        JSON.stringify(observation.value),
        currentTime,
        currentTime,
        currentTime,
        sourceId,
      );
  }

  advanceSourceBaseline(sourceId, changeRow, currentTime, memoryId) {
    const source = this.getTrackedSource(sourceId);
    this.database
      .prepare(`
        UPDATE tracked_sources
        SET memory_id = ?, last_fingerprint = ?, last_value_json = ?,
            last_checked_at = ?, last_changed_at = ?, status = 'healthy',
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(
        memoryId ?? source.memory_id,
        changeRow.observed_fingerprint,
        changeRow.observed_value_json,
        currentTime,
        currentTime,
        currentTime,
        sourceId,
      );
  }

  markSourceChanged(sourceId, currentTime) {
    this.database
      .prepare(`
        UPDATE tracked_sources
        SET last_checked_at = ?, last_changed_at = ?, status = 'changed',
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(currentTime, currentTime, currentTime, sourceId);
  }

  getTrackedSource(id) {
    const row = this.database.prepare("SELECT * FROM tracked_sources WHERE id = ?").get(id);
    if (!row) {
      throw new FreshMemoryError(`Tracked source ${id} was not found.`, "NOT_FOUND");
    }
    return this.hydrateSource(row);
  }

  getSourceChange(id) {
    const row = this.database.prepare("SELECT * FROM source_changes WHERE id = ?").get(id);
    if (!row) {
      throw new FreshMemoryError(`Source change ${id} was not found.`, "NOT_FOUND");
    }
    return this.hydrateSourceChange(row);
  }

  listSourcesForMemory(memoryId) {
    return this.database
      .prepare("SELECT * FROM tracked_sources WHERE memory_id = ? ORDER BY created_at ASC")
      .all(memoryId)
      .map((row) => this.hydrateSource(row));
  }

  hydrateSource(row) {
    return {
      id: row.id,
      memory_id: row.memory_id,
      kind: row.kind,
      path: row.path,
      selector: row.selector,
      statement_template: row.statement_template,
      mode: row.mode,
      interval_seconds: row.interval_seconds,
      last_fingerprint: row.last_fingerprint,
      last_value: JSON.parse(row.last_value_json),
      last_checked_at: row.last_checked_at,
      last_changed_at: row.last_changed_at,
      status: row.status,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  hydrateSourceChange(row) {
    const source = this.getTrackedSource(row.source_id);
    return {
      id: row.id,
      source_id: row.source_id,
      source: {
        kind: source.kind,
        path: source.path,
        selector: source.selector,
        mode: source.mode,
      },
      old_memory_id: row.old_memory_id,
      previous_value: JSON.parse(row.previous_value_json),
      observed_value: JSON.parse(row.observed_value_json),
      proposed_statement: row.proposed_statement,
      state: row.state,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
      resolution_reason: row.resolution_reason,
      replacement_memory_id: row.replacement_memory_id,
    };
  }

  sourceOptions() {
    return {
      roots: this.sourceRoots,
      maxBytes: this.maxSourceBytes,
    };
  }

  getMemory(id) {
    const row = this.database.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!row) {
      throw new FreshMemoryError(`Memory ${id} was not found.`, "NOT_FOUND");
    }
    return this.hydrateMemory(row);
  }

  hydrateMemory(row) {
    const dependencies = this.database
      .prepare("SELECT depends_on_id FROM dependencies WHERE memory_id = ? ORDER BY depends_on_id")
      .all(row.id)
      .map((dependency) => dependency.depends_on_id);
    const tags = this.database
      .prepare("SELECT tag FROM tags WHERE memory_id = ? ORDER BY tag")
      .all(row.id)
      .map((tag) => tag.tag);
    const freshness = this.computeFreshness(row, dependencies);

    return {
      id: row.id,
      key: row.memory_key,
      type: row.type,
      statement: row.statement,
      scope: row.scope,
      source: row.source,
      confidence: row.confidence,
      base_state: row.base_state,
      status: freshness.status,
      status_reasons: freshness.reasons,
      valid_from: row.valid_from,
      review_after: row.review_after,
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      superseded_by: row.superseded_by,
      depends_on: dependencies,
      tags,
      metadata: JSON.parse(row.metadata_json),
    };
  }

  computeFreshness(row, dependencies, visited = new Set()) {
    const temporal = this.computeTemporalFreshness(row);
    if (temporal.status !== "active") {
      return temporal;
    }

    if (visited.has(row.id)) {
      return {
        status: "needs_review",
        reasons: [`Dependency cycle detected at ${row.id}.`],
      };
    }
    const traversalPath = new Set(visited);
    traversalPath.add(row.id);

    if (row.memory_key) {
      const candidates = this.database
        .prepare(`
          SELECT * FROM memories
          WHERE scope = ? AND memory_key = ? AND base_state = 'active' AND id <> ?
        `)
        .all(row.scope, row.memory_key, row.id)
        .filter((candidate) => this.computeTemporalFreshness(candidate).status !== "expired");

      if (candidates.length > 0) {
        return {
          status: "conflicted",
          reasons: [`Another current memory uses key ${row.memory_key}.`],
        };
      }
    }

    const dependencyProblems = [];
    for (const dependencyId of dependencies) {
      const dependency = this.database.prepare("SELECT * FROM memories WHERE id = ?").get(dependencyId);
      if (!dependency) {
        dependencyProblems.push(`${dependencyId} is missing`);
        continue;
      }
      const dependencyDependencies = this.database
        .prepare("SELECT depends_on_id FROM dependencies WHERE memory_id = ?")
        .all(dependencyId)
        .map((item) => item.depends_on_id);
      const dependencyFreshness = this.computeFreshness(
        dependency,
        dependencyDependencies,
        traversalPath,
      );
      if (dependencyFreshness.status !== "active") {
        dependencyProblems.push(`${dependencyId} is ${dependencyFreshness.status}`);
      }
    }

    if (dependencyProblems.length > 0) {
      return {
        status: "needs_review",
        reasons: dependencyProblems.map((problem) => `Dependency ${problem}.`),
      };
    }

    return { status: "active", reasons: [] };
  }

  computeTemporalFreshness(row) {
    if (row.base_state !== "active") {
      return {
        status: row.base_state,
        reasons: [
          row.base_state === "superseded"
            ? `Replaced by ${row.superseded_by}.`
            : "Explicitly invalidated.",
        ],
      };
    }

    const now = this.now().getTime();
    if (row.expires_at && Date.parse(row.expires_at) <= now) {
      return { status: "expired", reasons: [`Expired at ${row.expires_at}.`] };
    }
    if (row.review_after && Date.parse(row.review_after) <= now) {
      return { status: "needs_review", reasons: [`Review was due at ${row.review_after}.`] };
    }
    return { status: "active", reasons: [] };
  }

  searchRows(query, scope, limit) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    const scopeParameters = scope ? [scope] : [];
    const scopeClause = scope ? "AND m.scope IN (?, 'global')" : "";

    if (!normalizedQuery || normalizedQuery === "*") {
      return this.database
        .prepare(`
          SELECT m.* FROM memories m
          WHERE 1 = 1 ${scopeClause}
          ORDER BY m.updated_at DESC
          LIMIT ?
        `)
        .all(...scopeParameters, limit);
    }

    const matchQuery = buildFtsQuery(normalizedQuery);
    if (!matchQuery) {
      return [];
    }

    if (!this.fullTextSearchEnabled) {
      return this.searchRowsWithoutFts(normalizedQuery, scope, limit);
    }

    return this.database
      .prepare(`
        SELECT m.*
        FROM memories_fts f
        JOIN memories m ON m.id = f.memory_id
        WHERE memories_fts MATCH ? ${scopeClause}
        ORDER BY bm25(memories_fts), m.updated_at DESC
        LIMIT ?
      `)
      .all(matchQuery, ...scopeParameters, limit);
  }

  searchRowsWithoutFts(query, scope, limit) {
    const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    if (tokens.length === 0) {
      return [];
    }

    const parameters = [];
    const tokenClauses = tokens.map((token) => {
      const pattern = `%${escapeLikePattern(token)}%`;
      parameters.push(pattern, pattern, pattern, pattern, pattern);
      return `(
        m.statement LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        COALESCE(m.memory_key, '') LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        m.scope LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        COALESCE(m.source, '') LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        EXISTS (
          SELECT 1 FROM tags t
          WHERE t.memory_id = m.id AND t.tag LIKE ? ESCAPE '\\' COLLATE NOCASE
        )
      )`;
    });
    const scopeClause = scope ? "AND m.scope IN (?, 'global')" : "";
    if (scope) {
      parameters.push(scope);
    }
    parameters.push(limit);

    return this.database
      .prepare(`
        SELECT m.*
        FROM memories m
        WHERE (${tokenClauses.join(" OR ")}) ${scopeClause}
        ORDER BY m.updated_at DESC
        LIMIT ?
      `)
      .all(...parameters);
  }

  assertDependenciesExist(dependencies) {
    const statement = this.database.prepare("SELECT 1 FROM memories WHERE id = ?");
    for (const dependencyId of dependencies) {
      if (!statement.get(dependencyId)) {
        throw new FreshMemoryError(
          `Dependency ${dependencyId} was not found.`,
          "NOT_FOUND",
        );
      }
    }
  }

  getDependentIds(id) {
    return this.database
      .prepare("SELECT memory_id FROM dependencies WHERE depends_on_id = ? ORDER BY memory_id")
      .all(id)
      .map((row) => row.memory_id);
  }

  recordEvent(memoryId, eventType, details) {
    this.database
      .prepare("INSERT INTO events (memory_id, event_type, details_json, created_at) VALUES (?, ?, ?, ?)")
      .run(memoryId, eventType, JSON.stringify(details), this.currentIsoTime());
  }

  syncSearchRow(memoryId) {
    if (!this.fullTextSearchEnabled) {
      return;
    }
    const memory = this.database.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId);
    const tags = this.database
      .prepare("SELECT tag FROM tags WHERE memory_id = ? ORDER BY tag")
      .all(memoryId)
      .map((row) => row.tag)
      .join(" ");

    this.database.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId);
    this.database
      .prepare(`
        INSERT INTO memories_fts (memory_id, statement, memory_key, scope, source, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        memory.id,
        memory.statement,
        memory.memory_key ?? "",
        memory.scope,
        memory.source ?? "",
        tags,
      );
  }

  transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  currentIsoTime() {
    return this.now().toISOString();
  }

  close() {
    this.database.close();
  }
}

function requiredString(value, field) {
  const normalized = optionalString(value, field);
  if (!normalized) {
    throw new FreshMemoryError(`${field} is required.`);
  }
  return normalized;
}

function optionalString(value, field) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new FreshMemoryError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  return normalized || null;
}

function requiredEnum(value, field, allowedValues) {
  const normalized = requiredString(value, field);
  if (!allowedValues.includes(normalized)) {
    throw new FreshMemoryError(
      `${field} must be one of: ${allowedValues.join(", ")}.`,
    );
  }
  return normalized;
}

function normalizeDate(value, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new FreshMemoryError(`${field} must be an ISO date or timestamp.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new FreshMemoryError(`${field} must be a valid date or timestamp.`);
  }
  return date.toISOString();
}

function normalizeConfidence(value) {
  if (value === undefined || value === null) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new FreshMemoryError("confidence must be a number between 0 and 1.");
  }
  return value;
}

function normalizeLimit(value, maximum = 100) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new FreshMemoryError(`limit must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizeInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new FreshMemoryError(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function normalizeStringList(value, field) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new FreshMemoryError(`${field} must be an array of strings.`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FreshMemoryError("metadata must be an object.");
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new FreshMemoryError("metadata must be JSON serializable.");
  }
}

function addDays(isoDate, days) {
  if (days === null) {
    return null;
  }
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function buildFtsQuery(query) {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

function escapeLikePattern(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function compactWarning(memory) {
  return {
    id: memory.id,
    key: memory.key,
    type: memory.type,
    statement: memory.statement,
    status: memory.status,
    reasons: memory.status_reasons,
    superseded_by: memory.superseded_by,
  };
}
