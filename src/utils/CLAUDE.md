# src/utils

Utility functions for CLI, path resolution, and data generation.

## Files

- **cli-helpers.ts** – CLI output formatting (colors, tables, spinners) using Chalk
- **path-helpers.ts** – Path resolution for config, DB, sockets, logs
- **ulid.ts** – ULID generation for session/instance IDs
- **types.ts** – Utility type definitions
- **errors.ts** – Error classes and error handling

## Patterns

- All path functions use `path.join()` and expand `~` via `os.homedir()`
- ULIDs are cryptographically secure, sortable by timestamp
- CLI helpers abstract Chalk for consistent coloring (success, error, warning, info)
- Error classes inherit from Error and include context (code, details)

## Usage

```typescript
import { success, error, spinner } from './cli-helpers'
import { configPath, dbPath } from './path-helpers'
import { generateULID } from './ulid'
```
