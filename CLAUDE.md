# Klaude: Multi-Agent Wrapper for Claude Code

TypeScript/Node.js project. See `prd.md` for architecture, DB schema, and implementation details.

## Quick Reference

**What it does**: Wrapper that spawns Claude Code and manages multi-agent sessions with context switching via native Claude `--resume`.

**Tech stack**: TypeScript, Commander (CLI), SQLite (WAL mode), Claude Agent SDK, Chalk, js-yaml

**Key paths**:
- `~/.klaude/sessions.db` – SQLite DB (projects, instances, sessions, events, links)
- `~/.klaude/config.yaml` – Config (claudeBinary, socketDir, switch.graceSeconds)
- `~/.klaude/run/<projectHash>/` – Per-project runtime (sockets, instance registry)
- `~/.klaude/projects/<projectHash>/logs/` – Session logs

**Core concept**: Each `klaude` invocation creates a wrapper instance (unique `instanceId`), spawns Claude, and communicates via Unix sockets. Hooks in Claude's settings link native Claude session IDs to Klaude session IDs for seamless `--resume` checkout.

## Build/Dev/Test

```bash
npm install
npm run build          # tsc + tsc-alias + npm link (installs globally)
npm run dev           # tsc --watch
npm test              # vitest
npm run lint          # eslint
npm run format        # prettier
```

## Implementation Status

✓ DB + models (ULID, SQLite schema)
◐ Wrapper loop (socket server, Claude spawn/kill)
◐ Hooks (session-start/session-end)
○ Agent runtime (SDK runner, event streaming)
○ UX polish (sessions -v, read -t, error handling)

## Core Files

- `src/index.ts` – CLI entry point (Commander)
- `src/config/` – Config loading, project hashing, defaults
- `src/db/` – SQLite initialization, WAL mode, CRUD
- `src/services/` – Config loading, wrapper orchestration
- `src/types/` – TypeScript interfaces for DB and CLI
- `src/utils/` – Path helpers, ULID generation

## CLI Contract (from prd.md)

- `klaude` – Start wrapper + Claude TUI
- `klaude start <agent_type> <prompt> [options]` – Spawn agent (attach/detach)
- `klaude checkout [id] [--instance <id>]` – Switch to agent via Claude --resume
- `klaude message <id> <prompt>` – Send message to running agent
- `klaude interrupt <id>` – SIGINT/SIGTERM to agent runtime
- `klaude sessions [-v]` – List sessions for project
- `klaude read <id> [-t | -s]` – Read/tail session log
- `klaude instances` – List active wrapper instances
- `klaude hook session-start|session-end` – Hook handler (internal)

## Hooks Setup

Install in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "klaude hook session-start"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "klaude hook session-end"}]}]
  }
}
```

Wrapper exports: `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`

## Key Constraints

- **No fallbacks**: Fail fast with clear error codes (E_SWITCH_TARGET_MISSING, E_AGENT_NOT_RUNNING, etc.)
- **No exclusive locks**: Multiple wrapper instances per project run concurrently
- **Attached/detached parity**: Both write to same logs, DB, event streams
- **Foreground TUI only**: No PTY emulation; each instance owns its TTY

## Notes

- `prd.md` has full architecture, schema, CLI spec, error model
- `README.md` has quick-start and user-facing command examples
- Hooks are critical for `--resume` checkout to work; without them, operations fail with clear errors
