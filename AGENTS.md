# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Klaude is a TypeScript CLI wrapper for the Claude Agent SDK that enables multi-agent session management. It provides stateful agent orchestration where agents can be spawned, managed, and communicate with each other across isolated sessions, backed by SQLite persistence.

## Build & Development Commands

```bash
# Build the TypeScript project
npm run build

# Watch mode for development
npm run dev

# Run the CLI
npm start

# Format code with Prettier
npm run format

# Lint with ESLint
npm run lint

# Run tests with Vitest
npm test

# Generate test coverage
npm run test:coverage

# Clean build artifacts
npm run clean
```

## Project Structure

### Core Directories

**`src/types/`**
- `index.ts`: Central type definitions for all core interfaces
  - `Session`: Represents a unique agent execution context with status lifecycle
  - `Agent`: Active agent instance with abort control and timing
  - `Message`: Inter-agent communication messages
  - Service manager interfaces: `ISessionManager`, `IAgentManager`, `IMessageQueue`, `ILogger`
  - `CLIContext`: Runtime context passed through command handlers
  - `KlaudeConfig`: Configuration structure from `~/.klaude/config.yaml`

**`src/config/`**
- `constants.ts`: Application-wide constants and magic values
  - Paths: `KLAUDE_HOME` (`~/.klaude`), `KLAUDE_DB_PATH`, `KLAUDE_LOGS_DIR`, `KLAUDE_CONFIG_FILE`
  - Timeouts: `DEFAULT_AGENT_TIMEOUT` (10 min), `MESSAGE_WAIT_TIMEOUT` (30 sec)
  - Session management: `MAX_CONCURRENT_AGENTS` (10), `SESSION_ID_LENGTH` (12), `LOG_RETENTION_DAYS` (30)
  - Valid agent types enumerated (orchestrator, planner, programmer, junior-engineer, context-engineer, senior-engineer, library-docs-writer, non-dev)
- `defaults.ts`: Default configuration values (`DEFAULT_CONFIG`) including SDK model, session settings, and optional server config

**`src/db/`**
- `database.ts`: SQLite database initialization and connection management
  - Three main tables: `sessions`, `messages`, `active_agents`
  - Indexes on common query patterns (agent_type, status, created_at, session references)
  - Foreign key constraints and WAL mode enabled for reliability

**`src/utils/`**
- `path-helper.ts`: Path expansion and Klaude home directory management
  - `expandHome()`: Converts `~` to user home directory
  - Path getters for db, logs, config, and session log files
- `error-handler.ts`: Custom error types and safe execution wrappers
  - `KlaudeError` base class with error codes
  - Specific errors: `SessionNotFoundError`, `AgentNotFoundError`, `DatabaseError`, `ConfigError`, `ValidationError`
  - `safeExecute()`: Exhaustively handles KlaudeError, Error, and unknown types
  - `requireArg()`: Validates required arguments

## Architecture Patterns

### Session Model

Sessions represent isolated execution contexts for agents. Each session:
- Has a unique ID, agent type, and lifecycle status (created → running → completed/failed)
- Can have a parent session (for hierarchical agent spawning)
- Stores the initial prompt, result, and metadata
- Persists timing metadata (createdAt, updatedAt, completedAt)

### Service Manager Pattern

The codebase defines service manager interfaces that abstract implementations:
- `ISessionManager`: CRUD and lifecycle operations on sessions
- `IAgentManager`: Spawn, interrupt, and track active agents
- `IMessageQueue`: Inter-agent message passing with subscription support
- `ILogger`: Session-based logging with streaming and flush operations

These interfaces are passed through `CLIContext` to command handlers, enabling dependency injection and testability.

### Configuration System

Configuration is loaded from `~/.klaude/config.yaml` and merged with `DEFAULT_CONFIG` from `src/config/defaults.ts`. The `KlaudeConfig` interface supports:
- SDK settings: model selection, thinking tokens, permission mode, fallback model
- Session settings: auto-save interval, log retention, concurrent agent limits
- Optional server settings: enable/disable, port

### Database Schema

**sessions table**
- `id` (TEXT, PRIMARY KEY)
- `agent_type`, `status`, `prompt`, `result`, `metadata`
- `created_at`, `updated_at`, `completed_at` (INTEGER timestamps)
- `parent_session_id` (foreign key for hierarchies)

**messages table**
- `id`, `from_session_id`, `to_session_id` (foreign keys)
- `content`, `created_at`, `read_at`

**active_agents table**
- `session_id` (PRIMARY KEY, foreign key)
- `type`, `status`, `started_at`, `completed_at`

## Development Notes

- **TypeScript Strict Mode**: Enabled with `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`. No `any` types without explicit reason.
- **Path Resolution**: Uses `@/*` alias (configured in `tsconfig.json` baseUrl/paths) for clean imports
- **Database Access**: Always use the singleton instance from `initializeDatabase()` or `getDatabase()`. Schema initialization is automatic.
- **Error Handling**: Use `safeExecute()` for async operations to ensure explicit error handling. All caught errors result in a throw.
- **Log Retention**: Sessions older than `LOG_RETENTION_DAYS` (default 30) should be archived/cleaned periodically.

## File Organization

- **Entry point**: `dist/index.js` (compiled from TypeScript)
- **npm bin**: Registered as `klaude` command
- **Compiled output**: `dist/` directory (generated from `src/` via TypeScript compilation)
- **No test files yet**: `vitest` is configured but no `.test.ts` files exist in the project

## Key Dependencies

- **@anthropic-ai/claude-agent-sdk**: Core agent execution
- **better-sqlite3**: Persistent session/message storage
- **commander**: CLI argument parsing
- **js-yaml**: YAML config parsing
- **chalk**: Terminal styling
- **table**: Formatted table output for CLI commands
