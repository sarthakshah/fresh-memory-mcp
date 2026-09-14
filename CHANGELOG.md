# Changelog

All notable changes to FreshMemory are documented here.

The project follows semantic versioning after its first public release.

## [Unreleased]

### Documentation

- Prepared repository metadata and guidance for a GitHub-only public beta

### Planned

- Public HTTP and JSON API source adapter
- First external source integration

## [0.2.2] - 2026-09-13

### Security

- Disabled all local source-file access unless `FRESH_MEMORY_SOURCE_ROOTS` explicitly allows it
- Blocked accidental npm publication while private testing continues
- Expanded ignored sensitive and local-only file patterns

### Documentation

- Clarified the local-only trust boundary and private-release checklist

## [0.2.1] - 2026-09-12

### Fixed

- Added a lexical search fallback for Node.js and SQLite builds without FTS5
- Verified the minimum supported Node.js 22.13 runtime in GitHub Actions

### Documentation

- Added a private tester guide with setup, safety, scenarios, and feedback instructions

## [0.2.0] - 2026-09-07

### Added

- Local JSON and text source tracking
- Automatic supersession for exact structured changes
- Review queue for ambiguous source changes
- Background sync, status, changes, and watch commands
- Source path restrictions
- Campaign-budget freshness demonstration
- GitHub Actions validation and community documentation

## [0.1.0] - 2026-09-07

### Added

- Durable local SQLite memory
- Freshness dates, expiration, supersession, and invalidation
- Conflict detection and dependency impact propagation
