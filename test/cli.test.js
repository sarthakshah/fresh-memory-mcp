import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../src/cli.js";
import { FreshMemoryStore } from "../src/store.js";

test("sync command applies source changes using the configured database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fresh-memory-cli-test-"));
  const databasePath = join(directory, "memory.sqlite");
  const sourcePath = join(directory, "campaign.json");
  writeFileSync(sourcePath, JSON.stringify({ budget: "$50,000" }));
  const store = new FreshMemoryStore({ databasePath, sourceRoots: [directory] });
  const memory = store.remember({
    type: "fact",
    key: "campaign.budget",
    statement: "Campaign budget is $50,000.",
  });
  store.trackSource({
    memory_id: memory.id,
    kind: "json_file",
    path: sourcePath,
    selector: "/budget",
    statement_template: "Campaign budget is {{value}}.",
  });
  store.close();
  writeFileSync(sourcePath, JSON.stringify({ budget: "$35,000" }));

  let output = "";
  try {
    await runCommand(["sync"], {
      environment: {
        ...process.env,
        FRESH_MEMORY_DB: databasePath,
        FRESH_MEMORY_SOURCE_ROOTS: directory,
      },
      output: { write: (chunk) => { output += chunk; } },
    });

    const result = JSON.parse(output);
    const reopenedStore = new FreshMemoryStore({ databasePath, sourceRoots: [directory] });
    assert.equal(result.changed, 1);
    assert.equal(
      reopenedStore.recall({ query: "campaign budget" }).items[0].statement,
      "Campaign budget is $35,000.",
    );
    reopenedStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
