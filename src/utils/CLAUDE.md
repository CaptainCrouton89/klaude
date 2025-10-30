# src/utils

Utility functions for CLI, path resolution, data generation, error handling, and Node.js bootstrap.

## Files

- **cli-helpers.ts** – CLI output formatting (colors, tables, spinners) using Chalk
- **path-helper.ts** – Path resolution for config, DB, sockets, logs
- **ulid.ts** – ULID generation for session/instance IDs
- **logger.ts** – Logging utilities
- **error-handler.ts** – Error classes (KlaudeError + subclasses), formatting, and safe async execution
- **bootstrap.ts** – Node.js native module ABI compatibility checks; auto-detects and re-execs with compatible Node binary if needed

## Patterns

- **Error handling**: Custom error classes with typed error codes; `formatError()`/`printError()` provide terminal output with suggestions; `safeExecute()` wraps async ops with exhaustive error handling
- **Path resolution**: Use `path.join()` and expand `~` via `os.homedir()`
- **ULIDs**: Cryptographically secure, sortable by timestamp
- **CLI helpers**: Abstract Chalk for consistent coloring (success, error, warning, info)
- **Bootstrap**: Detects better-sqlite3 ABI mismatches via `ensureCompatibleNode()`, finds compatible Node binary in PATH, re-execs process if needed

## Usage

```typescript
import { formatError, printError, safeExecute, KlaudeError } from './error-handler'
import { success, error, spinner } from './cli-helpers'
import { configPath, dbPath } from './path-helper'
import { generateULID } from './ulid'
import { ensureCompatibleNode, logBootstrap } from './bootstrap'
```
