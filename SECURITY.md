# Security Policy

## Supported versions

Security fixes are applied to the latest released version of FreshMemory.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use the repository's private vulnerability reporting option in the Security tab.

Include:

- The affected version
- The source type and MCP client involved
- Reproduction steps with private data removed
- The impact and any known workaround

## Local data model

FreshMemory stores memories and source history in a local SQLite database. Version 0.2.2 makes no network requests.

Tracked files may contain sensitive information. Source-file access is denied by default. FreshMemory reads a file only when `FRESH_MEMORY_SOURCE_ROOTS` is configured and the file is inside an allowed directory. Place the SQLite database in a directory protected by the operating system's user permissions.

Tool responses intentionally avoid returning full text-file contents. Never commit databases, credentials, or private source files to the repository.
