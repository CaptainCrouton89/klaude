# Services: Wrapper Orchestration & IPC

Core business logic for spawning Claude, managing wrapper instances, coordinating multi-agent sessions via Unix sockets, and resolving MCP server configurations.

## Key Patterns

**Socket-based IPC**: Wrapper instance listens on `~/.klaude/run/<projectHash>/<instanceId>.sock`. Clients send newline-delimited JSON requests; wrapper responds with JSON and closes socket.

**Agent Definition Loading** (`agent-definitions.ts`): Parses agent markdown YAML frontmatter (name, description, allowedAgents, model, color, mcpServers, inheritProjectMcps, inheritParentMcps) from project and user directories. Supports arrays, booleans, strings. Cached to prevent repeated reads.

**MCP Resolution** (`mcp-loader.ts`, `mcp-resolver.ts`): Loads MCPs from three scopes (Local > Project > User). Agents inherit project MCPs by default; override with `mcpServers` frontmatter or inherit parent via `inheritParentMcps: true`.

**Session Log Streaming** (`session-log.ts`): Reads/tails newline-delimited JSON session logs. Filters messages, summarizes events, detects terminal events.

**Session Checkout** (`wrapper-instance.ts:1279-1478`): Validates Claude session ID, blocks concurrent checkouts, SIGTERM→SIGKILL current Claude, launch `--resume` for target.

**Hook Timing** (`wrapper-instance.ts:1001-1023`): Fresh Claude waits 10s for `session-start` hook to link session ID. Hard blocker—throws `E_HOOK_TIMEOUT` on failure.

**Message Resumption** (`wrapper-instance.ts:1119-1202`): Detects missing runtime, restarts resuming prior Claude session.

**Agent Runtime Event Streaming**: Child process outputs newline-delimited JSON events (status→claude-session→done/error). All recorded to DB + log.

## Socket Protocol

**Newline-delimited JSON**:
- Requests: `{ action: "ping|status|start-agent|checkout|message|interrupt", payload?: object }`
- Responses: `{ ok: boolean, result?: object, error?: { code, message } }`

## Critical Conventions

- **No exclusive locks**: Multiple wrapper instances per project run concurrently
- **Project hash**: SHA-256(root).slice(0, 24) for Unix socket path length constraints
- **Hook env vars**: `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`
- **Agent scopes**: Project agents (`.claude/agents/`) override user agents
