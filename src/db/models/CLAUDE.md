# DB Models

TypeScript types and CRUD operations for SQLite schema entities.

## File Overview

- `project.ts` – Project CRUD (get by hash/id, create, list)
- `instance.ts` – Instance CRUD (get by id, list, create, mark ended)
- `session.ts` – Session CRUD (get, list, create, update status/PID/links, mark ended)
- `event.ts` – Event CRUD
- `runtime-process.ts` – Process runtime CRUD
- `claude-session-link.ts` – Claude ↔ Klaude link CRUD

## Key Patterns

**Type Safety**: Each file exports a mapper function that validates and type-casts raw DB rows to types from `@/types/db.js`.

**Error Handling**: All operations throw `DatabaseError` with context-specific messages.

**Timestamps**: ISO 8601 strings (SQLite TEXT) for `created_at`, `updated_at`, `started_at`, `ended_at`.

**Status Fields**: Session and instance have explicit status strings (`active`, `completed`, `failed`, etc.).

**Null Handling**: Mapper functions explicitly handle null/undefined DB values during type casting.

## Integration Notes

- Used by `src/services/` for business logic
- All queries use prepared statements via `better-sqlite3`
- Foreign keys enforced (`PRAGMA foreign_keys = ON` in `src/db/database.js`)
- Event table supports streaming via query filters (session ID, timestamp range)
- Session link relies on hook integration; see root CLAUDE.md for hook setup
