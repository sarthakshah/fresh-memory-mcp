import { defaultDatabasePath, FreshMemoryError, FreshMemoryStore } from "./store.js";
import { parseSourceRoots } from "./source-reader.js";

export async function runCommand(
  argumentsList,
  {
    environment = process.env,
    output = process.stdout,
    errorOutput = process.stderr,
  } = {},
) {
  const command = argumentsList[0];
  const store = new FreshMemoryStore({
    databasePath: defaultDatabasePath(environment),
    sourceRoots: parseSourceRoots(environment.FRESH_MEMORY_SOURCE_ROOTS),
  });

  try {
    switch (command) {
      case "sync":
        writeJson(output, store.syncSources());
        return;
      case "status":
        writeJson(output, store.watchStatus());
        return;
      case "changes":
        writeJson(output, store.reviewChanges());
        return;
      case "watch":
        await watch(store, argumentsList.slice(1), output, errorOutput);
        return;
      default:
        throw new FreshMemoryError(`Unknown command: ${command}.`);
    }
  } finally {
    store.close();
  }
}

async function watch(store, argumentsList, output, errorOutput) {
  const pollSeconds = parsePollSeconds(argumentsList);
  writeJson(output, {
    watching: true,
    poll_seconds: pollSeconds,
    initial_sync: store.syncSources(),
  });

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!stopped) {
      await delay(pollSeconds * 1000);
      if (stopped) {
        break;
      }
      const result = store.syncSources({ due_only: true });
      if (result.changed > 0 || result.errors > 0) {
        writeJson(result.errors > 0 ? errorOutput : output, result);
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function parsePollSeconds(argumentsList) {
  const index = argumentsList.indexOf("--poll");
  if (index === -1) {
    return 5;
  }
  const value = Number(argumentsList[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 3600) {
    throw new FreshMemoryError("--poll must be an integer between 1 and 3600.");
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
