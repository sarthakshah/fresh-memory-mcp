# FreshMemory Public Beta Testing Guide

Thank you for testing FreshMemory `0.2.2`. The goal of this public beta is to learn whether source-aware memory prevents practical mistakes without creating unnecessary work.

## What you are testing

FreshMemory helps an AI assistant distinguish current information from information that changed, expired, conflicted, or depended on an outdated fact.

Version `0.2.2` can:

- Store and recall durable memories
- Preserve replacements and invalidations
- Flag decisions affected by outdated supporting facts
- Track exact values inside local JSON files
- Detect local text-file changes without interpreting them automatically
- Run entirely on the local machine without API keys or network calls

## Safety before testing

- Use sample or non-sensitive information.
- Set `FRESH_MEMORY_SOURCE_ROOTS` to a dedicated test directory.
- Set `FRESH_MEMORY_DB` to a dedicated test database.
- Do not share the database or source files in bug reports.
- Remove private values from screenshots and logs.

## Requirements

- Node.js 22.13 or newer
- Codex, Claude Desktop, or another MCP-compatible client

## Install from GitHub

```bash
git clone https://github.com/sarthakshah/fresh-memory-mcp.git
cd fresh-memory-mcp
npm run release:check
npm install --global .
fresh-memory-mcp --version
```

The final command should print `0.2.2`.

## Quick demonstration

```bash
npm run demo
```

Expected result:

- The campaign budget changes from `$50,000` to `$35,000`.
- Recall returns only `$35,000` as current.
- The paid-search allocation becomes `needs_review` because it depended on the old budget.

## Connect to Codex

Create a dedicated directory for test source files, then register FreshMemory:

```bash
codex mcp add fresh-memory \
  --env FRESH_MEMORY_DB=/absolute/path/to/fresh-memory-test.sqlite \
  --env FRESH_MEMORY_SOURCE_ROOTS=/absolute/path/to/test-files \
  -- fresh-memory-mcp
```

Open a new Codex task after registration so the MCP tool list reloads.

## Scenario 1: Basic replacement

Ask your assistant:

> Use FreshMemory to remember that the test campaign budget is $50,000. The stable key is campaign.test.budget and the scope is tester-demo.

Then ask:

> The test campaign budget changed to $35,000. Replace the old memory, then recall the current campaign budget.

Expected result:

- `$35,000` is returned as the current value.
- `$50,000` remains in history as superseded.

## Scenario 2: Dependency impact

Ask your assistant to remember both facts in order:

1. The campaign budget is `$50,000`.
2. Allocate `$20,000` to paid search, depending on the budget memory.

Then replace the budget with `$35,000` and ask for a memory audit.

Expected result:

- The paid-search allocation is marked `needs_review`.
- The explanation identifies the superseded budget dependency.

## Scenario 3: Automatic JSON update

Create `campaign.json` inside the allowed test directory:

```json
{
  "campaign": {
    "budget": "$50,000"
  }
}
```

Ask the assistant to:

1. Remember `The campaign budget is $50,000.`
2. Track `campaign.json` as a `json_file`.
3. Use selector `/campaign/budget`.
4. Use statement template `The campaign budget is {{value}}.`
5. Use `auto` mode.

Change the file value to `$35,000`, then ask the assistant to sync sources and recall the campaign budget.

Expected result:

- FreshMemory detects the exact structured change.
- The old memory is superseded automatically.
- Recall returns `$35,000`.

## Scenario 4: Safe text review

Create a text file containing a sample policy. Track it as a `text_file`, then edit the policy and sync sources.

Expected result:

- FreshMemory creates a pending change.
- It does not invent a replacement statement.
- The previous memory remains active until the change is accepted or dismissed.

## What feedback is most useful

Please report:

- Operating system and Node.js version
- MCP client and FreshMemory version
- Which scenario you attempted
- What you expected and what happened
- Whether the warnings were understandable and actionable
- Any moment where FreshMemory updated too much or required unnecessary review

Use the repository's bug or feature-request template. Never include credentials, private memories, databases, or sensitive source contents.

## Reset the test

Stop the MCP server and watcher, then delete the dedicated test SQLite file. FreshMemory does not send a copy elsewhere.

## Known limitations

- Sources are limited to local JSON and text files.
- Search is lexical, not semantic.
- There is no shared team memory or access-control layer.
- External APIs and hosted platforms are not connected yet.
