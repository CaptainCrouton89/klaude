# Klaude: Multi-Agent Wrapper for Claude Code

TypeScript/Node.js project. Wrapper that spawns Claude Code as a subprocess and manages multiple agent sessions with seamless context switching via native Claude `--resume`.

## Quick Reference

**What it does**: Enables spawning specialized agents (`orchestrator`, `programmer`, `context-engineer`, etc.) that run inside Claude Code with stateful session management and MCP configuration support.

**Tech stack**: TypeScript, Commander (CLI), SQLite (WAL mode), Claude Agent SDK, Chalk, js-yaml

**Key paths**:
- `~/.klaude/sessions.db` – SQLite DB (projects, instances, sessions, events, links)
- `~/.klaude/config.yaml` – Config (claudeBinary, socketDir, switch.graceSeconds, mcpServers)
- `~/.klaude/run/<projectHash>/` – Per-project runtime (sockets, instance registry)
- `~/.klaude/projects/<projectHash>/logs/` – Session logs

**Core concept**: Each `klaude` invocation spawns a wrapper instance that manages Claude Code as a subprocess. Commands like `klaude start <agent_type> <prompt>` spawn agents inside Claude; Klaude records both its session ID and Claude's native session ID for seamless `--resume` checkout.

## Build/Dev/Test

```bash
npm install
npm run build          # tsc + tsc-alias + npm link (installs globally)
npm run dev           # tsc --watch
npm test              # vitest
npm run lint          # eslint
npm run format        # prettier
```

## CLI Commands

All commands work from within the Claude Code TUI spawned by the wrapper:

- `klaude` – Start wrapper + Claude TUI
- `klaude start <agent_type> <prompt> [options]` – Spawn agent (type loaded from agents directory)
  - `-c, --checkout` – Checkout immediately after starting
  - `-s, --share` – Share context (last X messages) with new agent
  - `-d, --detach` – Start without streaming output
- `klaude checkout [id]` – Switch to agent via Claude `--resume`
- `klaude message <id> <prompt> [-w, --wait]` – Send async message to running agent
- `klaude interrupt <id>` – SIGINT/SIGTERM to agent runtime
- `klaude sessions [-v]` – List sessions (verbose shows details)
- `klaude read <id> [-t | -s]` – Read session log (tail or summarize)
- `klaude instances` – List active wrapper instances
- `klaude hook session-start|session-end` – Hook handler (internal)

**Agent Discovery**: Agent types are dynamically loaded from your agents directory (`~/.claude/agents/` or `./.claude/agents/`). Any agent definition available there can be spawned with `klaude start <agent_name> <prompt>`.

## MCP Server Configuration

Agents can be configured with specific MCP (Model Context Protocol) servers. MCPs are resolved in three phases: global registry → project config → per-agent config.

### Global MCP Registry

Define available MCPs in `~/.klaude/config.yaml` or project `.mcp.json`:

```yaml
# ~/.klaude/config.yaml
mcpServers:
  sql:
    type: stdio
    command: npx
    args: [-y, '@modelcontextprotocol/server-postgres']
    env:
      DATABASE_URL: postgresql://localhost/mydb
  json:
    type: stdio
    command: npx
    args: [-y, '@anthropic-ai/mcp-json']
```

### Per-Agent MCP Configuration

Agents specify MCPs in frontmatter:

```markdown
name: Database Analyst
mcpServers: sql, json
inheritProjectMcps: false
inheritParentMcps: false
```

**Frontmatter fields:**
- `mcpServers` – Comma-separated list of MCP names (explicit override)
- `inheritProjectMcps` – Inherit all MCPs from project `.mcp.json` (default: true)
- `inheritParentMcps` – Inherit parent agent's MCPs (default: false)

**Resolution logic:**
1. If `mcpServers` specified → Use only those MCPs
2. Otherwise: Start with project MCPs (if `inheritProjectMcps !== false`), then add parent's MCPs (if `inheritParentMcps === true`)

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

Wrapper exports: `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`

## Implementation Status

✓ DB + models (ULID, SQLite schema)
✓ Wrapper loop (socket server, Claude spawn/kill)
✓ Hooks (session-start/session-end)
◐ Agent runtime (SDK runner, event streaming)
◐ MCP server configuration (resolution logic)
○ UX polish (sessions -v, read -t, error handling)

## Core Files

- `src/index.ts` – CLI entry point (Commander)
- `src/config/` – Config loading, project hashing, defaults
- `src/db/` – SQLite initialization, WAL mode, CRUD
- `src/services/` – Wrapper orchestration, MCP loading, agent runtime
- `src/types/` – TypeScript interfaces for DB and CLI
- `src/utils/` – Path helpers, ULID generation

## Key Constraints

- **No fallbacks**: Fail fast with clear error codes
- **No exclusive locks**: Multiple wrapper instances per project run concurrently
- **Attached/detached parity**: Both write to same logs, DB, event streams
- **Foreground TUI only**: No PTY emulation; each instance owns its TTY

## Notes

- See `prd.md` for full architecture, schema, CLI spec, error model
- See `README.md` for user-facing examples and quick start
- Hooks are critical for `--resume` checkout; without them, operations fail with clear errors
- MCP configuration is hierarchical: global registry → project config → per-agent overrides
