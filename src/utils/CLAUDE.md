# src/utils

Utility functions for path resolution, CLI argument parsing, stdin handling, data generation, error handling, and Node.js bootstrap.

## Files

- **cli-helpers.ts** – Project directory resolution, Claude CLI flag parsing, stdin reading, session ID abbreviation
- **path-helper.ts** – Path resolution for config, DB, sockets, logs
- **ulid.ts** – ULID generation for session/instance IDs
- **logger.ts** – Logging utilities
- **error-handler.ts** – Error classes (KlaudeError + subclasses), formatting, safe async execution
- **bootstrap.ts** – Node.js native module ABI compatibility checks; auto-detects and re-execs with compatible Node binary if needed

## Key Utilities

**cli-helpers.ts**:
- `resolveProjectDirectory()` – Resolve project from option or cwd
- `parseClaudeFlags()` – Classify flags into one-time (e.g., `-r`) and persistent (e.g., `--dangerously-skip-permissions`)
- `readStdin()` – Read UTF-8 input from stdin; returns empty if TTY
- `abbreviateSessionId()` – Last 6 chars of ULID for display

**Error handling**: Custom error classes with typed error codes; `formatError()`/`printError()` for terminal output; `safeExecute()` wraps async ops

**ULIDs**: Cryptographically secure, sortable by timestamp

**Bootstrap**: Detects better-sqlite3 ABI mismatches, finds compatible Node binary, re-execs if needed
