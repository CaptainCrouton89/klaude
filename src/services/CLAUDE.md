# Services: Wrapper Orchestration & IPC

Core business logic for spawning Claude, managing wrapper instances, and coordinating multi-agent sessions via Unix sockets.

## Key Patterns

**Socket-based IPC**: Wrapper instance listens on `~/.klaude/run/<projectHash>/<instanceId>.sock`. Clients send newline-delimited JSON requests; wrapper responds with JSON and closes socket (one-shot per connection).

**Session Checkout State Machine** (`wrapper-instance.ts:1279-1478`): Complex dance:
1. Validate target session has Claude session ID (try active link → wait for hooks → wait for SDK)
2. Set `state.pendingSwitch` to block concurrent checkouts
3. Send SIGTERM to current Claude, wait `switch.graceSeconds`, then SIGKILL
4. On Claude exit, detect `pendingSwitch` and launch Claude `--resume` for target
5. Resolve checkout promise when target Claude spawns

**Hook Timing Criticality** (`wrapper-instance.ts:1001-1023`): Fresh Claude launches wait 10s for `session-start` hook to link Claude session ID. This is a hard blocker—if hook fails to fire, wrapper throws `E_HOOK_TIMEOUT`. Existing sessions skip this since links exist.

**Message Resumption** (`wrapper-instance.ts:1119-1202`): If agent runtime stopped, incoming message detects missing runtime, restarts it resuming prior Claude session. Resume ID selection: active link → latest link → wait for active link/last ID.

**Agent Runtime Event Streaming**: Child process outputs newline-delimited JSON events. Wrapper streams events: `status` (pending→running→completed) → `claude-session` link creation → `done`/`error`. All recorded to DB + session log.

**Error Handling**: Fail fast with specific codes (E_HOOK_TIMEOUT, E_SWITCH_TARGET_MISSING, E_AGENT_NOT_RUNNING). No fallbacks.

## File Overview

| File | Purpose |
|------|---------|
| `wrapper-instance.ts` | Socket server, Claude/agent spawn, event streaming, session checkout |
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
- **Agent runtime entry**: Built to `src/runtime/agent-runtime.js`; wrapper spawns as subprocess via stdin/stdout event stream
- **Detached agents**: Support both attached (TUI-aware) and detached (headless) modes via `StartAgentRequestPayload.options.detach`
