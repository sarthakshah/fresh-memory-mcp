import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FreshMemoryStore } from "../src/store.js";

const FIXED_NOW = "2026-09-07T12:00:00.000Z";

function createStore(databasePath = ":memory:", options = {}) {
  return new FreshMemoryStore({
    databasePath,
    now: () => new Date(FIXED_NOW),
    ...options,
  });
}

test("remembers and recalls a current fact", (context) => {
  const store = createStore();
  context.after(() => store.close());

  const memory = store.remember({
    type: "fact",
    key: "campaign.september.budget",
    statement: "The September campaign budget is $50,000.",
    scope: "acme",
    source: "approved-media-plan.xlsx",
    tags: ["campaign", "budget"],
  });
  const result = store.recall({ query: "September budget", scope: "acme" });

  assert.equal(memory.status, "active");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, memory.id);
  assert.equal(result.warnings.length, 0);
});

test("recalls memories when SQLite FTS5 is unavailable", (context) => {
  const store = new FreshMemoryStore({
    databasePath: ":memory:",
    now: () => new Date(FIXED_NOW),
    enableFullTextSearch: false,
  });
  context.after(() => store.close());
  const memory = store.remember({
    type: "fact",
    key: "campaign.september.budget",
    statement: "The September campaign budget is $50,000.",
    scope: "acme",
    tags: ["paid-search"],
  });

  const byStatement = store.recall({ query: "campaign budget", scope: "acme" });
  const byTag = store.recall({ query: "paid-search", scope: "acme" });

  assert.equal(byStatement.items[0].id, memory.id);
  assert.equal(byTag.items[0].id, memory.id);
});

test("excludes expired memories by default and reports a warning", (context) => {
  const store = createStore();
  context.after(() => store.close());

  const memory = store.remember({
    type: "constraint",
    statement: "The launch discount is valid through August.",
    valid_from: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
  });
  const currentOnly = store.recall({ query: "launch discount" });
  const withStale = store.recall({ query: "launch discount", include_stale: true });

  assert.equal(currentOnly.items.length, 0);
  assert.equal(currentOnly.warnings[0].status, "expired");
  assert.equal(withStale.items[0].id, memory.id);
  assert.equal(withStale.items[0].status, "expired");
});

test("superseding a fact preserves history and returns only the replacement", (context) => {
  const store = createStore();
  context.after(() => store.close());

  const original = store.remember({
    type: "fact",
    key: "campaign.september.budget",
    statement: "The September campaign budget is $50,000.",
    scope: "acme",
  });
  const result = store.supersede({
    old_id: original.id,
    statement: "The September campaign budget is $35,000.",
    reason: "Client approved a revised media plan.",
  });
  const recalled = store.recall({ query: "September campaign budget", scope: "acme" });

  assert.equal(result.previous.status, "superseded");
  assert.equal(result.previous.superseded_by, result.replacement.id);
  assert.equal(result.replacement.status, "active");
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].statement, "The September campaign budget is $35,000.");
  assert.equal(recalled.warnings[0].status, "superseded");
});

test("marks dependents for review when a dependency is superseded", (context) => {
  const store = createStore();
  context.after(() => store.close());

  const budget = store.remember({
    type: "fact",
    key: "campaign.budget",
    statement: "Campaign budget is $50,000.",
    scope: "acme",
  });
  const allocation = store.remember({
    type: "decision",
    statement: "Allocate $20,000 to paid search.",
    scope: "acme",
    depends_on: [budget.id],
  });

  const change = store.supersede({
    old_id: budget.id,
    statement: "Campaign budget is $35,000.",
  });
  const explained = store.explain({ id: allocation.id });

  assert.deepEqual(change.affected_dependents, [allocation.id]);
  assert.equal(explained.memory.status, "needs_review");
  assert.match(explained.memory.status_reasons[0], /superseded/);
});

test("propagates freshness problems through multiple dependency levels", (context) => {
  const store = createStore();
  context.after(() => store.close());

  const budget = store.remember({
    type: "fact",
    statement: "Campaign budget is $50,000.",
  });
  const allocation = store.remember({
    type: "decision",
    statement: "Allocate $20,000 to paid search.",
    depends_on: [budget.id],
  });
  const forecast = store.remember({
    type: "assumption",
    statement: "Paid search will produce 400 conversions.",
    depends_on: [allocation.id],
  });

  store.invalidate({ id: budget.id, reason: "The media plan was withdrawn." });

  assert.equal(store.getMemory(allocation.id).status, "needs_review");
  assert.equal(store.getMemory(forecast.id).status, "needs_review");
});

test("flags a dependent when its supporting memory is conflicted", (context) => {
  const store = createStore();
  context.after(() => store.close());

  const firstDefinition = store.remember({
    type: "fact",
    key: "reporting.revenue",
    statement: "Revenue includes refunds.",
    scope: "finance",
  });
  store.remember({
    type: "fact",
    key: "reporting.revenue",
    statement: "Revenue excludes refunds.",
    scope: "finance",
  });
  const report = store.remember({
    type: "decision",
    statement: "Use revenue in the quarterly report.",
    scope: "finance",
    depends_on: [firstDefinition.id],
  });

  assert.equal(store.getMemory(firstDefinition.id).status, "conflicted");
  assert.equal(store.getMemory(report.id).status, "needs_review");
});

test("detects two current memories with the same key as a conflict", (context) => {
  const store = createStore();
  context.after(() => store.close());

  store.remember({
    type: "fact",
    key: "reporting.revenue",
    statement: "Revenue includes refunds.",
    scope: "finance",
  });
  store.remember({
    type: "fact",
    key: "reporting.revenue",
    statement: "Revenue excludes refunds.",
    scope: "finance",
  });
  const result = store.recall({ query: "revenue refunds", scope: "finance" });

  assert.equal(result.items.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => warning.status === "conflicted"));
});

test("invalidating a memory preserves it and flags its dependents", (context) => {
  const store = createStore();
  context.after(() => store.close());

  const source = store.remember({
    type: "assumption",
    statement: "The landing page will be ready Monday.",
  });
  const decision = store.remember({
    type: "decision",
    statement: "Launch the campaign Monday.",
    depends_on: [source.id],
  });
  const result = store.invalidate({ id: source.id, reason: "Launch was delayed." });

  assert.equal(result.memory.status, "invalidated");
  assert.deepEqual(result.affected_dependents, [decision.id]);
  assert.equal(store.getMemory(decision.id).status, "needs_review");
});

test("persists memory across store restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-test-"));
  const databasePath = join(directory, "memory.sqlite");

  try {
    const firstStore = createStore(databasePath);
    const memory = firstStore.remember({
      type: "preference",
      statement: "Weekly reports should be concise.",
    });
    firstStore.close();

    const secondStore = createStore(databasePath);
    assert.equal(secondStore.getMemory(memory.id).statement, memory.statement);
    secondStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit groups memories that need attention", (context) => {
  const store = createStore();
  context.after(() => store.close());

  store.remember({
    type: "fact",
    statement: "An expired fact.",
    valid_from: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
  });
  store.remember({
    type: "decision",
    statement: "A decision due for review.",
    review_after: "2026-09-06T00:00:00.000Z",
  });

  const result = store.audit();

  assert.equal(result.attention_count, 2);
  assert.equal(result.groups.expired.length, 1);
  assert.equal(result.groups.needs_review.length, 1);
});

test("automatically supersedes memory when a tracked JSON value changes", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-source-test-"));
  const sourcePath = join(directory, "campaign.json");
  writeFileSync(sourcePath, JSON.stringify({ campaign: { budget: "$50,000" } }));
  const store = createStore(":memory:", { sourceRoots: [directory] });
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const budget = store.remember({
    type: "fact",
    key: "campaign.budget",
    scope: "acme",
    statement: "Campaign budget is $50,000.",
  });
  const allocation = store.remember({
    type: "decision",
    scope: "acme",
    statement: "Allocate $20,000 to paid search.",
    depends_on: [budget.id],
  });
  const tracked = store.trackSource({
    memory_id: budget.id,
    kind: "json_file",
    path: sourcePath,
    selector: "/campaign/budget",
    statement_template: "Campaign budget is {{value}}.",
    mode: "auto",
  });

  writeFileSync(sourcePath, JSON.stringify({ campaign: { budget: "$35,000" } }));
  const synced = store.syncSources({ source_id: tracked.source.id });
  const recalled = store.recall({ query: "campaign budget", scope: "acme" });
  const source = store.getTrackedSource(tracked.source.id);

  assert.equal(synced.changed, 1);
  assert.equal(synced.results[0].action, "updated");
  assert.equal(synced.results[0].change.previous_value, "$50,000");
  assert.equal(synced.results[0].change.observed_value, "$35,000");
  assert.equal(recalled.items[0].statement, "Campaign budget is $35,000.");
  assert.equal(store.getMemory(budget.id).status, "superseded");
  assert.equal(store.getMemory(allocation.id).status, "needs_review");
  assert.equal(source.memory_id, recalled.items[0].id);
  assert.equal(source.status, "healthy");
});

test("holds text file changes for review and avoids duplicate pending changes", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-text-test-"));
  const sourcePath = join(directory, "policy.txt");
  writeFileSync(sourcePath, "Refunds are allowed within 30 days.\n");
  const store = createStore(":memory:", { sourceRoots: [directory] });
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const policy = store.remember({
    type: "constraint",
    key: "refund.window",
    scope: "support",
    statement: "Refunds are allowed within 30 days.",
  });
  const tracked = store.trackSource({
    memory_id: policy.id,
    kind: "text_file",
    path: sourcePath,
    mode: "review",
  });

  writeFileSync(sourcePath, "Refunds are allowed within 14 days.\n");
  const firstSync = store.syncSources();
  const secondSync = store.syncSources();
  const pending = store.reviewChanges({ scope: "support" });

  assert.equal(firstSync.results[0].action, "pending");
  assert.equal(secondSync.results[0].duplicate, true);
  assert.equal(pending.pending_count, 1);
  assert.equal(store.getMemory(policy.id).status, "active");

  const resolved = store.resolveSourceChange({
    change_id: pending.changes[0].id,
    action: "accept",
    statement: "Refunds are allowed within 14 days.",
    reason: "Policy owner approved the revision.",
  });

  assert.equal(resolved.action, "updated");
  assert.equal(store.reviewChanges().pending_count, 0);
  assert.equal(store.getTrackedSource(tracked.source.id).status, "healthy");
  assert.equal(
    store.recall({ query: "refunds allowed", scope: "support" }).items[0].statement,
    "Refunds are allowed within 14 days.",
  );
});

test("reports a tracked source that becomes unavailable", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-missing-test-"));
  const sourcePath = join(directory, "settings.json");
  writeFileSync(sourcePath, JSON.stringify({ limit: 10 }));
  const store = createStore(":memory:", { sourceRoots: [directory] });
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const memory = store.remember({ type: "fact", statement: "The limit is 10." });
  store.trackSource({
    memory_id: memory.id,
    kind: "json_file",
    path: sourcePath,
    selector: "/limit",
    statement_template: "The limit is {{value}}.",
  });
  unlinkSync(sourcePath);

  const synced = store.syncSources();
  const status = store.watchStatus();

  assert.equal(synced.errors, 1);
  assert.equal(synced.results[0].action, "error");
  assert.equal(status.attention_count, 1);
  assert.equal(status.sources[0].health, "error");
});

test("restricts tracked files to configured source roots", (context) => {
  const allowedDirectory = mkdtempSync(join(tmpdir(), "fresh-memory-allowed-"));
  const outsideDirectory = mkdtempSync(join(tmpdir(), "fresh-memory-outside-"));
  const outsidePath = join(outsideDirectory, "campaign.json");
  writeFileSync(outsidePath, JSON.stringify({ budget: 100 }));
  const store = new FreshMemoryStore({
    databasePath: ":memory:",
    now: () => new Date(FIXED_NOW),
    sourceRoots: [allowedDirectory],
  });
  context.after(() => {
    store.close();
    rmSync(allowedDirectory, { recursive: true, force: true });
    rmSync(outsideDirectory, { recursive: true, force: true });
  });

  const memory = store.remember({ type: "fact", statement: "Budget is 100." });

  assert.throws(
    () => store.trackSource({
      memory_id: memory.id,
      kind: "json_file",
      path: outsidePath,
      selector: "/budget",
      statement_template: "Budget is {{value}}.",
    }),
    (error) => error.code === "SOURCE_NOT_ALLOWED",
  );
});

test("requires configured source roots before tracking a file", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-no-roots-test-"));
  const sourcePath = join(directory, "campaign.json");
  writeFileSync(sourcePath, JSON.stringify({ budget: 100 }));
  const store = createStore();
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const memory = store.remember({ type: "fact", statement: "Budget is 100." });

  assert.throws(
    () => store.trackSource({
      memory_id: memory.id,
      kind: "json_file",
      path: sourcePath,
      selector: "/budget",
      statement_template: "Budget is {{value}}.",
    }),
    (error) => error.code === "SOURCE_ROOTS_REQUIRED",
  );
});

test("rejects a JSON source baseline that disagrees with its memory", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-baseline-test-"));
  const sourcePath = join(directory, "campaign.json");
  writeFileSync(sourcePath, JSON.stringify({ budget: "$35,000" }));
  const store = createStore(":memory:", { sourceRoots: [directory] });
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const memory = store.remember({
    type: "fact",
    statement: "Campaign budget is $50,000.",
  });

  assert.throws(
    () => store.trackSource({
      memory_id: memory.id,
      kind: "json_file",
      path: sourcePath,
      selector: "/budget",
      statement_template: "Campaign budget is {{value}}.",
    }),
    (error) => error.code === "SOURCE_BASELINE_MISMATCH",
  );
});

test("clears pending changes when a source returns to its approved baseline", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-revert-test-"));
  const sourcePath = join(directory, "policy.txt");
  const originalPolicy = "Refunds are allowed within 30 days.\n";
  writeFileSync(sourcePath, originalPolicy);
  const store = createStore(":memory:", { sourceRoots: [directory] });
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const memory = store.remember({
    type: "constraint",
    statement: "Refunds are allowed within 30 days.",
  });
  store.trackSource({
    memory_id: memory.id,
    kind: "text_file",
    path: sourcePath,
  });

  writeFileSync(sourcePath, "Refunds are allowed within 14 days.\n");
  store.syncSources();
  writeFileSync(sourcePath, originalPolicy);
  const reverted = store.syncSources();

  assert.equal(reverted.results[0].action, "reverted");
  assert.equal(reverted.results[0].resolved_changes, 1);
  assert.equal(store.reviewChanges().pending_count, 0);
  assert.equal(store.watchStatus().sources[0].health, "healthy");
});
