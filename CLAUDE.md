# CLAUDE.md

TypeScript/Node.js project. Wrapper that spawns Claude Code as a subprocess and manages multiple agent sessions with seamless context switching via native Claude `--resume`.

## Quick Reference

**What it does**: Enables spawning specialized agents (`orchestrator`, `programmer`, `context-engineer`, etc.) that run inside Claude Code with stateful session management and MCP configuration support.

**Tech stack**: TypeScript, Commander (CLI), SQLite (WAL mode via better-sqlite3), Claude Agent SDK, Chalk, js-yaml

**Key paths**:
- `~/.klaude/sessions.db` – SQLite DB (projects, instances, sessions, events, links)
- `~/.klaude/config.yaml` – Config (claudeBinary, socketDir, switch.graceSeconds)
- `~/.klaude/run/<projectHash>/` – Per-project runtime (sockets, instance registry)

## Build/Dev/Test

```bash
pnpm install
pnpm run build          # tsc + tsc-alias
pnpm run dev            # tsc --watch
pnpm test               # vitest
pnpm run lint           # eslint
```

## Architecture

**Three-Tier Model:**
1. **CLI commands** (`src/commands/`) – Parse input, send IPC requests via Unix sockets
2. **Wrapper instance** (`src/services/wrapper-instance.ts`) – Manages Claude subprocess, socket server
3. **Agent runtime** (`src/runtime/agent-runtime.ts`) – Spawned subprocess, uses Claude Agent SDK

**Database Schema:**
- `projects` – Project root + SHA-256 hash (24 chars for socket limits)
- `instances` – Wrapper processes (PID, TTY, lifecycle)
- `sessions` – Klaude sessions (agent_type, parent_id, status)
- `claude_session_links` – Maps Klaude→Claude session IDs (enables `--resume`)
- `runtime_process` – Agent subprocess PIDs
- `events` – Event stream (all agent activity)

**Session Lifecycle:**
1. User runs `klaude start <agent> <prompt>` → CLI sends IPC request
2. Wrapper spawns agent runtime subprocess
3. Runtime uses Claude Agent SDK to run query
4. Runtime streams events to wrapper (newline-delimited JSON)
5. Wrapper writes events to DB + log file
6. `SessionStart` hook links Claude session ID to Klaude session

## Core Files

**Commands** (`src/commands/`): `start.ts`, `checkout.ts`, `wait.ts`, `status.ts`, `message.ts`, `interrupt.ts`, `sessions.ts`, `logs.ts`, `instances.ts`, `setup-hooks.ts`

**Services** (`src/services/`):
- `wrapper-instance.ts` – Socket server, Claude spawn/kill, session checkout
- `agent-definitions.ts` – Parse agent markdown YAML frontmatter
- `session-log.ts`, `mcp-loader.ts`, `mcp-resolver.ts`, `project-context.ts`, `instance-client.ts`, `instance-registry.ts`

**Runtime** (`src/runtime/`): `agent-runtime.ts`

**Database** (`src/db/`): `database.ts` (better-sqlite3 WAL wrapper), `models/` (CRUD)

**Utils** (`src/utils/`): `ulid.ts`, `path-helper.ts`, `logger.ts`, `error-handler.ts`, `cli-helpers.ts`

## Key Constraints

- **No fallbacks**: Fail fast with clear error codes
- **No exclusive locks**: SQLite WAL mode for concurrent wrapper instances
- **Project hash**: SHA-256(root).slice(0, 24) for socket path limits
- **Session IDs**: ULIDs for lexicographic sorting
- **Agent scoping**: Project agents (`./.claude/agents/`) override user agents
- **Hook dependency**: Checkout requires hooks installed; fails with `E_HOOK_TIMEOUT` without them

## Implementation Details

**Socket Protocol** (`wrapper-instance.ts`):
- Newline-delimited JSON over Unix sockets
- Request: `{ action: "ping|status|start-agent|checkout|message|interrupt", payload?: object }`
- Response: `{ ok: boolean, result?: object, error?: { code, message } }`

**Agent Definition** (`agent-definitions.ts`):
- Markdown with YAML frontmatter (delimited by `---`)
- Fields: `name`, `description`, `allowedAgents`, `model`, `color`, `mcpServers`, `inheritProjectMcps`, `inheritParentMcps`

**Session Checkout** (`wrapper-instance.ts:1279-1478`):
- Validates target has Claude session ID
- Blocks concurrent checkouts with in-flight flag
- SIGTERM → SIGKILL current Claude, launch new with `--resume <claude_session_id>`

**MCP Resolution** (`mcp-resolver.ts`):
1. If `mcpServers` specified → Use ONLY those (explicit override)
2. Otherwise: If `inheritProjectMcps !== false` add project MCPs; if `inheritParentMcps === true` add parent MCPs

**Event Streaming** (`runtime/agent-runtime.ts`):
- Runtime writes newline-delimited JSON events to stdout
- Event types: `status`, `message`, `log`, `result`, `error`, `claude-session`, `done`
- `claude-session` event triggers immediate DB link creation

## Notes

- See README.md for full CLI spec
- Hooks critical for `--resume` checkout; fails with clear errors without them
- Agent definitions dynamically loaded from `~/.claude/agents/` or `./.claude/agents/`
- pnpm users: Configure `enable-pre-post-scripts=true` in `.npmrc` for better-sqlite3 native builds
