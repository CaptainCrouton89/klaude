# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Klaude is a TypeScript CLI wrapper for Claude Code that enables multi-agent session management. It spawns Claude Code as a subprocess and provides stateful agent orchestration where agents can be spawned, managed, and communicate with each other across isolated sessions, backed by SQLite persistence. Klaude tracks both its internal session IDs and Claude Code's native session IDs for seamless context switching.

## Build & Development Commands

```bash
pnpm run build              # Build TypeScript, link to global bin
pnpm run dev                # Watch-mode TypeScript compilation
pnpm run lint               # ESLint on src/
pnpm run format             # Prettier formatting
pnpm run test               # Run vitest suite
pnpm run test:coverage      # Test with coverage report
pnpm run clean              # Remove dist/ directory
npm start                   # Run compiled dist/index.js directly
```

The `build` script compiles TypeScript, uses tsc-alias for path resolution, unlinks any previous global installation, and re-links the klaude binary globally. This enables `klaude` command availability in the shell.

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
- Stores both Klaude internal session IDs and Claude Code native session IDs

**`src/utils/`** — Helper utilities
- `path-helper.ts`: Path expansion, `KLAUDE_HOME` management
- `error-handler.ts`: `KlaudeError` base class, specific error types, `safeExecute()` wrapper

## Architecture Patterns

### Wrapper Loop

Klaude spawns Claude Code as a subprocess with session switching:
1. Wrapper spawns Claude Code with stdio inherited
2. User commands inside Claude (e.g., `enter-agent`) write marker files
3. Wrapper detects exit + marker file and respawns Claude with `--resume <claude-session-id>`
4. All sessions backed by SQLite — no history lost

Session switching preserves both Klaude's internal state and Claude Code's native session context.

### Hook Integration

Klaude ships a `hook` subcommand that Claude Code's settings can invoke:
- `SessionStart`: Records new Claude sessions (including `/clear`)
- `SessionEnd`: Marks sessions as completed and maintains parent/child relationships

Configure in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "klaude hook session-start"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "klaude hook session-end"}]}]
  }
}
```

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
- Wrapper settings: `claudeBinary` path (also via `CLAUDE_BINARY` or `KLAUDE_CLAUDE_BINARY` env vars)
- Optional server settings: enable/disable, port

### Database Schema

**sessions table**: `id`, `agent_type`, `status`, `prompt`, `result`, `metadata`, timestamps, `parent_session_id`, `claude_session_id` (tracks Claude Code's native session)
**messages table**: `id`, `from_session_id`, `to_session_id`, `content`, timestamps, `read_at`
**active_agents table**: `session_id`, `type`, `status`, `started_at`, `completed_at`

## Development Notes

- **TypeScript Strict Mode**: Enabled (`noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`). No `any` types without explicit reason.
- **Path Aliases**: Uses `@/*` alias (configured in `tsconfig.json`) for clean imports
- **Database**: Use `initializeDatabase()` or `getDatabase()` for singleton SQLite instance
- **Error Handling**: Use `safeExecute()` wrapper for async operations — all errors are caught and thrown
- **Testing**: Vitest suite in place for unit and integration tests
- **CLI Entry**: `bin.klaude` in package.json points to `dist/index.js`; `npm link` makes it globally available
- **Log Retention**: Sessions older than `LOG_RETENTION_DAYS` (default 30) should be archived/cleaned

## Key Dependencies

- `@anthropic-ai/claude-agent-sdk`: Core agent execution
- `sql.js`: In-memory SQLite with file persistence
- `commander`: CLI argument parsing
- `js-yaml`: YAML configuration
- `chalk`: Terminal styling
- `table`: Formatted table output

## Related Documentation

- **[README.md](./README.md)** — User-facing overview, commands, and quick start
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Session switching mechanism and implementation details
- **[AGENTS.md](./AGENTS.md)** — Agent types and roles
