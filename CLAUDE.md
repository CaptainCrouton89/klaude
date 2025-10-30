# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Klaude: Multi-Agent Wrapper for Claude Code

TypeScript/Node.js project. Wrapper that spawns Claude Code as a subprocess and manages multiple agent sessions with seamless context switching via native Claude `--resume`.

## Quick Reference

**What it does**: Enables spawning specialized agents (`orchestrator`, `programmer`, `context-engineer`, etc.) that run inside Claude Code with stateful session management and MCP configuration support.

**Tech stack**: TypeScript, Commander (CLI), SQLite (WAL mode via better-sqlite3), Claude Agent SDK, Chalk, js-yaml

**Key paths**:
- `~/.klaude/sessions.db` – SQLite DB (projects, instances, sessions, events, links)
- `~/.klaude/config.yaml` – Config (claudeBinary, socketDir, switch.graceSeconds)
- `~/.klaude/.mcp.json` – Global MCP server registry
- `~/.klaude/run/<projectHash>/` – Per-project runtime (sockets, instance registry)
- `~/.klaude/projects/<projectHash>/logs/` – Session logs (newline-delimited JSON)

**Core concept**: Each `klaude` invocation spawns a wrapper instance that manages Claude Code as a subprocess. Commands like `klaude start <agent_type> <prompt>` spawn agents inside Claude; Klaude records both its session ID and Claude's native session ID for seamless `--resume` checkout.

## Build/Dev/Test

```bash
npm install
npm run build          # tsc + tsc-alias + npm link
```

## CLI Commands

- `klaude` – Start wrapper + Claude TUI
- `klaude start <agent_type> <prompt>` – Spawn agent (-c/--checkout, -s/--share, -a/--attach options)
- `klaude checkout [id]` / `enter-agent [id]` – Switch to agent session
- `klaude wait <id...>` – Block until agent(s) complete (--timeout, --any options)
- `klaude status <id...>` – Check agent session status
- `klaude message <id> <prompt>` – Send async message to agent
- `klaude interrupt <id>` – SIGINT/SIGTERM to agent runtime
- `klaude sessions [-v]` – List sessions
- `klaude logs <id>` – Read session logs (-f/--follow, -s/--summary, -n/--lines, --head, --tail)
- `klaude instances [--status]` – List active wrapper instances
- `klaude setup-hooks` – Install hooks to ~/.claude/settings.json

Agent types are dynamically loaded from `~/.claude/agents/` or `./.claude/agents/`.

## MCP Server Configuration

MCPs are resolved hierarchically: global registry → project config → per-agent overrides.

### MCP Registries

**Global** (`~/.klaude/.mcp.json`):
```json
{
  "mcpServers": {
    "sql": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {"DATABASE_URL": "postgresql://localhost/mydb"}
    }
  }
}
```

**Project** (`.mcp.json` in project root):
```json
{
  "mcpServers": {
    "company-api": {
      "type": "stdio",
      "command": "/usr/local/bin/company-mcp"
    }
  }
}
```

### Per-Agent MCP Configuration

In agent frontmatter:
```markdown
name: Database Analyst
mcpServers: sql, json
inheritProjectMcps: false
inheritParentMcps: false
```

**Fields:**
- `mcpServers` – Explicit MCP list (overrides inheritance)
- `inheritProjectMcps` – Include project `.mcp.json` MCPs (default: true)
- `inheritParentMcps` – Include parent agent's MCPs (default: false)

**Resolution (in order):**
1. If `mcpServers` specified → Use only those
2. If `inheritProjectMcps !== false` → Add project MCPs
3. If `inheritParentMcps === true` → Add parent's MCPs

## Hooks Setup

Install in `./.claude/settings.local.json`:
```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "klaude hook session-start"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "klaude hook session-end"}]}]
  }
}
```

Or use: `klaude setup-hooks` (installs to ~/.claude/settings.json)

Wrapper exports: `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`


## Architecture Overview

**Three-Tier Process Model:**
1. **CLI commands** (`src/commands/`) – Parse user input, send IPC requests to wrapper
2. **Wrapper instance** (`src/services/wrapper-instance.ts`) – Manages Claude subprocess, handles IPC via Unix sockets
3. **Agent runtime** (`src/runtime/agent-runtime.ts`) – Spawned by wrapper, uses Claude Agent SDK to run queries, streams events back

**IPC Flow:**
```
CLI command → Unix socket request → Wrapper instance → Spawns agent runtime → Claude Agent SDK → Events → DB + Logs
```

**Database Schema:**
- `projects` – Project root paths + SHA-256 hash (24 chars for socket path limits)
- `instances` – Wrapper instance processes (PID, TTY, lifecycle)
- `sessions` – Klaude sessions (agent_type, parent_id, status, depth)
- `claude_session_links` – Maps Klaude session IDs to Claude Code session IDs (enables `--resume`)
- `runtime_process` – Agent subprocess PIDs (detached/attached tracking)
- `events` – Event stream (all agent activity, queryable)

**Session Lifecycle:**
1. User runs `klaude start <agent> <prompt>` → CLI sends IPC request
2. Wrapper spawns agent runtime subprocess, passes config via stdin
3. Runtime uses Claude Agent SDK to run query (or `--resume` existing session)
4. Runtime streams events to wrapper via stdout (newline-delimited JSON)
5. Wrapper writes events to DB + session log file
6. On `SessionStart` hook: Claude session ID is linked to Klaude session
7. On `SessionEnd` hook: Session marked complete in DB

## Core Files & Directories

**Commands** (`src/commands/`):
- `start.ts` – Spawn agent with type + prompt
- `checkout.ts` / `enter-agent.ts` – Switch to different agent session
- `wait.ts` – Block until agent(s) complete
- `status.ts` – Check session status
- `message.ts` – Send async message to running agent
- `interrupt.ts` – SIGINT/SIGTERM agent process
- `sessions.ts` – List all sessions with metadata
- `logs.ts` – Read/tail session logs (supports --follow, --lines, --summary)
- `instances.ts` – List active wrapper instances
- `setup-hooks.ts` – Install SessionStart/SessionEnd hooks to Claude settings

**Services** (`src/services/`):
- `wrapper-instance.ts` – Core orchestration: socket server, Claude spawn/kill, session checkout
- `agent-definitions.ts` – Parse agent markdown YAML frontmatter, cache definitions
- `session-log.ts` – Read/tail/format newline-delimited JSON logs
- `mcp-loader.ts` – Load MCPs from `.mcp.json` files (global + project)
- `mcp-resolver.ts` – Resolve agent MCP access via inheritance rules
- `project-context.ts` – Project root detection, hash generation
- `instance-client.ts` – Client-side IPC requests to wrapper socket
- `instance-registry.ts` – Track active wrapper instances in filesystem
- `config-loader.ts` – Load/merge config.yaml with defaults

**Runtime** (`src/runtime/`):
- `agent-runtime.ts` – Entry point for agent subprocess, uses Claude Agent SDK

**Database** (`src/db/`):
- `database.ts` – better-sqlite3 wrapper with WAL mode
- `models/` – CRUD operations for each table (project, instance, session, claude-session-link, runtime-process, event)

**Hooks** (`src/hooks/`):
- `session-hooks.ts` – SessionStart/SessionEnd handlers (link Claude session IDs, mark completion)

**Types** (`src/types/`):
- `index.ts` – Core types (ClaudeCliFlags, McpServerConfig, etc.)
- `db.ts` – Database row types
- `instance-ipc.ts` – IPC request/response payloads

**Utils** (`src/utils/`):
- `ulid.ts` – ULID generation for session IDs
- `path-helper.ts` – Path resolution (DB, logs, sockets)
- `logger.ts` – Event logging to session files
- `error-handler.ts` – Custom KlaudeError class
- `cli-helpers.ts` – CLI formatting utilities

## Key Constraints & Conventions

- **No fallbacks**: Fail fast with clear error codes. No silent degradation.
- **No exclusive locks**: Multiple wrapper instances per project run concurrently using SQLite WAL mode
- **Attached/detached parity**: Both modes write to same logs, DB, event streams
- **Foreground TUI only**: No PTY emulation; each instance owns its TTY
- **Project hash**: SHA-256(projectRoot).slice(0, 24) to fit Unix socket path length limits
- **Session IDs**: ULIDs for lexicographic sorting and timestamp encoding
- **Agent scoping**: Project agents (`./.claude/agents/`) override user agents (`~/.claude/agents/`)
- **Hook dependency**: Session checkout requires hooks to be installed; fails with `E_HOOK_TIMEOUT` without them
- **10-second hook timeout**: Fresh Claude launches wait 10s for `SessionStart` hook to link Claude session ID

## Important Implementation Details

**Socket Protocol** (`wrapper-instance.ts`):
- Newline-delimited JSON over Unix sockets (one request/response per connection)
- Socket path: `~/.klaude/run/<projectHash>/<instanceId>.sock`
- Request format: `{ action: "ping|status|start-agent|checkout|message|interrupt", payload?: object }`
- Response format: `{ ok: boolean, result?: object, error?: { code: string, message: string } }`

**Agent Definition Format** (`agent-definitions.ts`):
- Markdown files with YAML frontmatter delimited by `---`
- Frontmatter fields: `name`, `description`, `allowedAgents`, `model`, `color`, `mcpServers`, `inheritProjectMcps`, `inheritParentMcps`
- Body content becomes agent instructions passed to Claude
- Cached in memory to avoid repeated file reads

**Session Checkout Flow** (`wrapper-instance.ts:1279-1478`):
- Validates target session has Claude session ID (from hook)
- Blocks concurrent checkouts with in-flight flag
- Sends SIGTERM → SIGKILL to current Claude subprocess
- Launches new Claude with `--resume <claude_session_id>`
- Updates instance's active session tracking

**MCP Inheritance Resolution** (`mcp-resolver.ts`):
1. If agent frontmatter specifies `mcpServers` → Use ONLY those (explicit override)
2. Otherwise, start with empty set and conditionally add:
   - If `inheritProjectMcps !== false` → Add all project `.mcp.json` MCPs
   - If `inheritParentMcps === true` → Add parent agent's resolved MCPs
3. Result is merged into single config passed to agent runtime

**Event Streaming** (`runtime/agent-runtime.ts`):
- Agent runtime writes newline-delimited JSON events to stdout
- Event types: `status`, `message`, `log`, `result`, `error`, `claude-session`, `done`
- Wrapper reads events, writes to DB + session log file
- `claude-session` event triggers immediate DB link creation

**Development Workflow**:
- Edit TypeScript in `src/`
- Run `npm run build` to compile (tsc + tsc-alias)
- Binary is linked as `klaude` via `npm link` during build
- For development: `npm run dev` (watch mode)
- Tests: `npm test` (vitest)

## Notes

- See `README.md` for full CLI spec and examples
- Hooks are critical for `--resume` checkout; without them, operations fail with clear errors
- MCP configuration is JSON-based (`~/.klaude/.mcp.json` and project `.mcp.json`)
- Agent definitions dynamically loaded from `~/.claude/agents/` or `./.claude/agents/`
