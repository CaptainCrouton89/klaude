# DB Models

TypeScript interfaces and types for SQLite schema entities.

## File Overview

- `project.ts` – Project entity (name, directory, hash)
- `instance.ts` – Wrapper instance (unique per `klaude` invocation, TTY/socket management)
- `session.ts` – Claude session (tracks native Claude session ID, agent type, prompt, status)
- `event.ts` – Session events (log entries, messages, state transitions)
- `runtime-process.ts` – Agent process runtime (PID, socket path, exit code)
- `claude-session-link.ts` – Hook-managed link between Claude's native session ID and Klaude session ID

## Key Patterns

**Primary Keys**: All entities use ULID (`ulid()` from utils) for deterministic, sortable IDs.

**Timestamps**: `createdAt` and `updatedAt` as ISO 8601 strings (SQLite TEXT).

**Status Enums**: Session and process have explicit status strings (`pending`, `running`, `completed`, `failed`).

**Foreign Keys**: Enforced at type level; SQLite `PRAGMA foreign_keys = ON` in db/index.ts.

## Integration Notes

- Models are **read-only types** — all DB operations via `src/db/` CRUD functions
- Used by `src/services/` for business logic (config, wrapper orchestration)
- Event table supports streaming via query filters (session ID, timestamp range)
- Session link relies on hook integration; see root CLAUDE.md for hook setup
