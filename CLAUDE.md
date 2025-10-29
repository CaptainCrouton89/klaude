# Klaude: Multi-Agent Wrapper for Claude Code

TypeScript/Node.js project. Wrapper that spawns Claude Code as a subprocess and manages multiple agent sessions with seamless context switching via native Claude `--resume`.

## Quick Reference

**What it does**: Enables spawning specialized agents (`orchestrator`, `programmer`, `context-engineer`, etc.) that run inside Claude Code with stateful session management and MCP configuration support.

**Tech stack**: TypeScript, Commander (CLI), SQLite (WAL mode), Claude Agent SDK, Chalk, js-yaml

**Key paths**:
- `~/.klaude/sessions.db` – SQLite DB (projects, instances, sessions, events, links)
- `~/.klaude/config.yaml` – Config (claudeBinary, socketDir, switch.graceSeconds)
- `~/.klaude/.mcp.json` – Global MCP server registry
- `~/.klaude/run/<projectHash>/` – Per-project runtime (sockets, instance registry)
- `~/.klaude/projects/<projectHash>/logs/` – Session logs

**Core concept**: Each `klaude` invocation spawns a wrapper instance that manages Claude Code as a subprocess. Commands like `klaude start <agent_type> <prompt>` spawn agents inside Claude; Klaude records both its session ID and Claude's native session ID for seamless `--resume` checkout.

## Build/Dev/Test

```bash
npm install
npm run build          # tsc + tsc-alias + npm link
npm run dev           # tsc --watch
npm test              # vitest
npm run lint          # eslint
npm run format        # prettier
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

## Implementation Status

✓ DB + models (ULID, SQLite schema)
✓ Wrapper loop (socket server, Claude spawn/kill)
✓ Hooks (session-start/session-end)
✓ Agent runtime (SDK runner, event streaming)
✓ MCP server configuration (resolution logic)
✓ CLI polish (normalized commands: logs, wait, status, --timeout flags, line-limiting options)

## Core Files

- `src/index.ts` – CLI entry point
- `src/config/` – Config loading, project hashing
- `src/db/` – SQLite initialization, WAL mode, CRUD
- `src/services/` – Wrapper orchestration, MCP loading, agent runtime
- `src/types/` – TypeScript interfaces
- `src/utils/` – Path helpers, ULID generation

## Key Constraints

- **No fallbacks**: Fail fast with clear error codes
- **No exclusive locks**: Multiple wrapper instances per project run concurrently
- **Attached/detached parity**: Both write to same logs, DB, event streams
- **Foreground TUI only**: No PTY emulation; each instance owns its TTY

## Notes

- See `README.md` for full CLI spec and examples
- See `prd.md` for architecture, schema, and error model
- Hooks are critical for `--resume` checkout; without them, operations fail with clear errors
- MCP configuration is now JSON-based (`~/.klaude/.mcp.json` and `.mcp.json`)
