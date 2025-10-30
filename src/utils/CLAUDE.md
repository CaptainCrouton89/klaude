# src/utils

Utility functions for CLI, path resolution, data generation, and error handling.

## Files

- **cli-helpers.ts** – CLI output formatting (colors, tables, spinners) using Chalk
- **path-helper.ts** – Path resolution for config, DB, sockets, logs
- **ulid.ts** – ULID generation for session/instance IDs
- **logger.ts** – Logging utilities
- **error-handler.ts** – Error classes (KlaudeError + subclasses), formatting, and safe async execution

## Patterns

- **Error handling**: Custom error classes with typed error codes; `formatError()`/`printError()` provide terminal output with suggestions; `safeExecute()` wraps async ops with exhaustive error handling
- **Path resolution**: Use `path.join()` and expand `~` via `os.homedir()`
- **ULIDs**: Cryptographically secure, sortable by timestamp
- **CLI helpers**: Abstract Chalk for consistent coloring (success, error, warning, info)

## Usage

```typescript
import { formatError, printError, safeExecute, KlaudeError } from './error-handler'
import { success, error, spinner } from './cli-helpers'
import { configPath, dbPath } from './path-helper'
import { generateULID } from './ulid'
```
