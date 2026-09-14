# Contributing to FreshMemory

FreshMemory favors small, explainable changes that make agent memory safer in practical workflows.

## Local setup

Requirements:

- Node.js 22.13 or newer
- Git

Run the complete validation suite:

```bash
npm run release:check
```

No dependency installation is required for the current codebase.

## Development principles

- Preserve memory history instead of overwriting or deleting it.
- Never interpret unstructured source changes automatically.
- Keep local data local unless a source adapter explicitly documents network use.
- Make source access boundaries configurable.
- Return structured, actionable errors.
- Add tests for success, failure, and reversal paths.

## Adding a source adapter

A source adapter should:

1. Produce a deterministic fingerprint.
2. Separate structured values from unstructured content.
3. Define whether changes may be applied automatically.
4. Fail closed when a source is unavailable or ambiguous.
5. Avoid returning credentials or full sensitive documents in tool responses.

Document any network access, authentication, rate limits, and data retention before adding an external adapter.

## Pull requests

- Keep each pull request focused on one problem.
- Include tests for behavior changes.
- Update the README and changelog when users will notice the change.
- Run `npm run release:check` before requesting review.
- Do not commit SQLite databases, credentials, or private source files.
