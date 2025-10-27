# Services: Wrapper Orchestration & IPC

Core business logic for spawning Claude, managing wrapper instances, and coordinating multi-agent sessions via Unix sockets.

## Key Patterns

**Socket-based IPC**: Wrapper instance listens on `~/.klaude/run/<projectHash>/<instanceId>.sock`. Clients send newline-delimited JSON requests, receive live session data.

**Instance Lifecycle**:
1. `wrapper-instance.ts:spawn()` creates new wrapper, starts socket server
2. Hook handlers persist Claude session → Klaude session links
3. `instance-client.ts` provides CLI-side request/response interface

**Error Codes**: Fail fast with specific error codes (see `src/types/errors.ts`). No fallbacks.

## File Overview

| File | Purpose |
|------|---------|
| `wrapper-instance.ts` | Socket server, Claude spawn/kill, request dispatch |
| `instance-client.ts` | CLI-side net client, IPC request marshaling |
| `config.ts` | Load/validate config, project hashing |
| `session-hooks.ts` | session-start/session-end handlers |
| `process.ts` | Process lifecycle (spawn, kill, attach/detach) |

## Critical Conventions

- **No exclusive locks**: Multiple instances per project run concurrently; use DB row versioning
- **Newline-delimited JSON**: Socket protocol is one JSON object per line
- **Export env vars**: Hooks receive `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`
- **Attached/detached parity**: Both modes write to same logs and DB

## See Also

- `prd.md` – Full architecture, CLI spec, error model
- `src/types/instance-ipc.ts` – IPC request/response types
- `src/hooks/session-hooks.ts` – Hook dispatch logic
