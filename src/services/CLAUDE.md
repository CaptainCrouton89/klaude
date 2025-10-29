# Services: Wrapper Orchestration & IPC

Core business logic for spawning Claude, managing wrapper instances, coordinating multi-agent sessions via Unix sockets, and resolving MCP server configurations.

## Key Patterns

**Socket-based IPC**: Wrapper instance listens on `~/.klaude/run/<projectHash>/<instanceId>.sock`. Clients send newline-delimited JSON requests; wrapper responds with JSON and closes socket (one-shot per connection).

**Agent Definition Loading** (`agent-definitions.ts`): Parses agent markdown files from project and user directories. Files use YAML-style key:value header (name, description, allowedAgents, model, color, mcpServers) followed by instructions. Caching prevents repeated file reads.

**MCP Resolution** (`mcp-loader.ts`, `mcp-resolver.ts`): Loads MCPs from `.mcp.json` (project) and `config.yaml` (user). Agents inherit project MCPs by default; can override with `mcpServers` frontmatter or inherit parent agent's MCPs via `inheritParentMcps: true`.

**Session Checkout** (`wrapper-instance.ts:1279-1478`): Validates target session has Claude session ID, blocks concurrent checkouts, SIGTERM→SIGKILL current Claude, then launch `--resume` for target.

**Hook Timing** (`wrapper-instance.ts:1001-1023`): Fresh Claude launches wait 10s for `session-start` hook to link Claude session ID. Hard blocker—throws `E_HOOK_TIMEOUT` on failure.

**Message Resumption** (`wrapper-instance.ts:1119-1202`): Detects missing runtime, restarts it resuming prior Claude session.

**Agent Runtime Event Streaming**: Child process outputs newline-delimited JSON events (status→claude-session→done/error). All recorded to DB + session log.

## File Overview

| File | Purpose |
|------|---------|
| `wrapper-instance.ts` | Socket server, Claude/agent spawn, event streaming, session checkout |
| `agent-definitions.ts` | Parse agent markdown metadata, compose prompts, manage agent cache |
| `mcp-loader.ts` | Load MCPs from `.mcp.json` and `config.yaml` |
| `mcp-resolver.ts` | Resolve agent's MCP server access based on inheritance rules |
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

- **No exclusive locks**: Multiple instances per project run concurrently
- **Project hash**: SHA-256(projectRoot).slice(0, 24) for Unix socket path length constraints
- **Export env vars**: Hooks receive `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`
- **Agent scopes**: Project scope (`.claude/agents/`) takes precedence over user scope (`~/.claude/agents/`)
