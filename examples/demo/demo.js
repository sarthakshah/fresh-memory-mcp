import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FreshMemoryStore } from "../../src/store.js";

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const workingDirectory = mkdtempSync(join(tmpdir(), "fresh-memory-demo-"));
const sourcePath = join(workingDirectory, "campaign.json");
copyFileSync(join(exampleDirectory, "campaign.json"), sourcePath);

const store = new FreshMemoryStore({
  databasePath: join(workingDirectory, "memory.sqlite"),
  sourceRoots: [workingDirectory],
});

try {
  const budget = store.remember({
    type: "fact",
    key: "campaign.september.budget",
    scope: "demo",
    statement: "The September campaign budget is $50,000.",
  });
  const allocation = store.remember({
    type: "decision",
    scope: "demo",
    statement: "Allocate $20,000 to paid search.",
    depends_on: [budget.id],
  });
  const tracked = store.trackSource({
    memory_id: budget.id,
    kind: "json_file",
    path: sourcePath,
    selector: "/campaign/budget",
    statement_template: "The September campaign budget is {{value}}.",
    mode: "auto",
  });

  writeFileSync(
    sourcePath,
    JSON.stringify({
      campaign: {
        name: "September Launch",
        budget: "$35,000",
        paid_search_allocation: "$20,000",
      },
    }, null, 2),
  );

  const sync = store.syncSources({ source_id: tracked.source.id });
  const currentBudget = store.recall({ query: "September campaign budget" }).items[0];
  const impactedDecision = store.getMemory(allocation.id);

  process.stdout.write(`${JSON.stringify({
    detected_change: sync.results[0].change,
    current_memory: currentBudget.statement,
    impacted_decision: {
      statement: impactedDecision.statement,
      status: impactedDecision.status,
      reasons: impactedDecision.status_reasons,
    },
  }, null, 2)}\n`);
} finally {
  store.close();
  rmSync(workingDirectory, { recursive: true, force: true });
}
