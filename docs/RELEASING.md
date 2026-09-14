# Releasing

## Local checklist

1. Update the version in `package.json`, `src/server.js`, and `bin/fresh-memory-mcp.js`.
2. Move relevant changelog entries from `Unreleased` into the release version.
3. Run `npm run release:check`.
4. Inspect the package contents printed by `npm pack --dry-run`.
5. Confirm that no database, credentials, or private source files are included.
6. Keep `"private": true` and the `prepublishOnly` guard while distribution remains GitHub-only.
7. Commit the release changes and create a matching Git tag only for an approved release.

## npm publishing

Publishing to npm is intentionally disabled. GitHub repository visibility does not change this. Before the first npm release:

- Choose the npm organization or owner.
- Add the final repository URL to `package.json`.
- Enable GitHub private vulnerability reporting.
- Decide whether npm publishing uses trusted publishing or a scoped token.
- Remove `"private": true` and the `prepublishOnly` guard only after publication is explicitly approved.

Never place npm or GitHub credentials in the repository.

## GitHub public beta

For the GitHub-only beta:

1. Keep npm publishing disabled.
2. Direct testers to `docs/TESTING.md`.
3. Ask them to use sample data and submit feedback through the issue templates.
4. Triage installation failures separately from memory-safety feedback.
5. Resolve high-impact problems before tagging a stable release.

Testers can clone `main` directly. A GitHub release and matching tag are optional until the beta is stable.
