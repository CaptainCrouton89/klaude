# Services: Wrapper Orchestration & IPC

Core business logic for spawning Claude, managing wrapper instances, and coordinating multi-agent sessions via Unix sockets.

## Key Patterns

**Socket-based IPC**: Wrapper instance listens on `~/.klaude/run/<projectHash>/<instanceId>.sock`. Clients send newline-delimited JSON requests, receive live session data.

**Instance Lifecycle**:
1. `project-context.ts:prepareProjectContext()` resolves project root, derives SHA-256 hash, scaffolds directories
2. `wrapper-instance.ts:startWrapperInstance()` creates socket server, spawns Claude, dispatches IPC requests
3. Hook handlers persist Claude session → Klaude session links via env vars
4. `instance-client.ts` provides CLI-side request/response interface

**Error Handling**: Fail fast with specific error codes (KlaudeError). No fallbacks.

## File Overview

| File | Purpose |
|------|---------|
| `wrapper-instance.ts` | Socket server, Claude spawn/kill, agent session dispatch |
| `project-context.ts` | Project root resolution, hash derivation, directory scaffolding |
| `instance-client.ts` | CLI-side net client, IPC request marshaling |
| `config.ts` | Load/validate config, expose wrapper settings |
| `session-hooks.ts` | session-start/session-end handlers |
| `instance-registry.ts` | Registry of active wrapper instances |
| `process.ts` | Process lifecycle (spawn, kill, attach/detach) |

## Socket Protocol

**Newline-delimited JSON**: One request/response per line.
- Requests: `{ action: "ping|status|start-agent|checkout|message|interrupt", payload?: object }`
- Responses: `{ ok: boolean, result?: object, error?: { code: string, message: string } }`

## Critical Conventions

- **No exclusive locks**: Multiple instances per project run concurrently; use DB row versioning
- **Project hash**: SHA-256(projectRoot).slice(0, 24) for Unix socket path length constraints
- **Export env vars**: Hooks receive `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`
- **TTY detection**: Dynamic TTY path detection for proper foreground TUI behavior

## See Also

- `prd.md` – Full architecture, CLI spec, error model
- `src/types/instance-ipc.ts` – IPC request/response types
