# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Klaude is a TypeScript CLI wrapper for Claude Code that enables multi-agent session management. It spawns Claude Code as a subprocess and provides stateful agent orchestration where agents can be spawned, managed, and communicate with each other across isolated sessions, backed by SQLite persistence.

## Build & Development Commands

```bash
pnpm run build       # Build the TypeScript project
```

## Project Structure

**`src/types/index.ts`** — Central type definitions
- `Session`, `Agent`, `Message` interfaces for core domain model
- Service managers: `ISessionManager`, `IAgentManager`, `IMessageQueue`, `ILogger`
- `CLIContext` (runtime context), `KlaudeConfig` (configuration from `~/.klaude/config.yaml`)

**`src/config/`** — Application-wide constants and defaults
- `constants.ts`: Paths, timeouts (`DEFAULT_AGENT_TIMEOUT` 10 min), agent types, session limits (10 concurrent)
- `defaults.ts`: Default configuration merged with user config

**`src/db/database.ts`** — SQLite database at `~/.klaude/sessions.db`
- Three tables: `sessions`, `messages`, `active_agents` with indexes and foreign keys
- Uses `sql.js` for in-memory SQLite with file persistence and WAL mode

**`src/utils/`** — Helper utilities
- `path-helper.ts`: Path expansion, `KLAUDE_HOME` management
- `error-handler.ts`: `KlaudeError` base class, specific error types, `safeExecute()` wrapper

## Architecture Patterns

### Wrapper Loop

Klaude spawns Claude Code as a subprocess with session switching:
1. Wrapper spawns Claude Code with stdio inherited
2. User commands inside Claude (e.g., `enter-agent`) write marker files
3. Wrapper detects exit + marker file and respawns Claude with new session context
4. All sessions backed by SQLite — no history lost

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed session switching mechanism.

### Session Model

Sessions represent isolated execution contexts for agents:
- Unique ID, agent type, lifecycle status (created → running → completed/failed)
- Optional parent session for hierarchical agent spawning
- Stores prompt, result, and timing metadata

### Service Manager Pattern

Interfaces passed through `CLIContext` to command handlers (enables dependency injection):
- `ISessionManager`: CRUD and lifecycle operations
- `IAgentManager`: Spawn, interrupt, track active agents
- `IMessageQueue`: Inter-agent message passing
- `ILogger`: Session-based logging

### Configuration System

Configuration loaded from `~/.klaude/config.yaml` and merged with defaults. Supports:
- SDK settings: model selection, thinking tokens, permission mode, fallback model
- Session settings: auto-save interval, log retention, concurrent agent limits
- Optional server settings: enable/disable, port

### Database Schema

**sessions table**: `id`, `agent_type`, `status`, `prompt`, `result`, `metadata`, timestamps, `parent_session_id`
**messages table**: `id`, `from_session_id`, `to_session_id`, `content`, timestamps, `read_at`
**active_agents table**: `session_id`, `type`, `status`, `started_at`, `completed_at`

## Development Notes

- **TypeScript Strict Mode**: Enabled (`noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`). No `any` types without explicit reason.
- **Path Aliases**: Uses `@/*` alias (configured in `tsconfig.json`) for clean imports
- **Database**: Use `initializeDatabase()` or `getDatabase()` for singleton SQLite instance
- **Error Handling**: Use `safeExecute()` wrapper for async operations — all errors are caught and thrown
- **Log Retention**: Sessions older than `LOG_RETENTION_DAYS` (default 30) should be archived/cleaned

## Key Dependencies

- `@anthropic-ai/claude-agent-sdk`: Core agent execution
- `sql.js`: In-memory SQLite with file persistence
- `commander`: CLI argument parsing
- `js-yaml`: YAML configuration
- `chalk`: Terminal styling
- `table`: Formatted table output

## Related Documentation

- **[README.md](./README.md)** — User-facing overview and command reference
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Session switching mechanism and implementation details
- **[AGENTS.md](./AGENTS.md)** — Agent types and roles
