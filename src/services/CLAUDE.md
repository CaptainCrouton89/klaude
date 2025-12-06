# Services: Wrapper Orchestration & IPC

Core business logic for spawning Claude, managing wrapper instances, coordinating multi-agent sessions via Unix sockets, and resolving MCP server configurations.

## Key Patterns

**Socket-based IPC**: Wrapper instance listens on `~/.klaude/run/<projectHash>/<instanceId>.sock`. Clients send newline-delimited JSON requests; wrapper responds with JSON and closes socket.

**Agent Definition Loading** (`agent-definitions.ts`): Parses agent markdown YAML frontmatter (name, description, allowedAgents, model, color, mcpServers, inheritProjectMcps, inheritParentMcps, reasoningEffort, runtime, outputDir) from project and user directories. Markdown body becomes `instructions` field. Supports arrays, booleans, strings. Cached to prevent repeated reads.
- `reasoningEffort`: 'low' | 'medium' | 'high' – Controls extended thinking for Claude models (default: medium from config)
- `outputDir`: Relative path for auto-saving agent output (e.g., 'plans' → .claude/plans/)
- `runtime`: Optional 'codex' | 'cursor' hint for GPT models (overrides config default)
- `instructions`: Markdown body content after frontmatter delimiter (non-YAML agent prompts)

**MCP Resolution** (`mcp-loader.ts`, `mcp-resolver.ts`): Loads MCPs from three scopes (Local > Project > User). Agents inherit project MCPs by default; override with `mcpServers` frontmatter or inherit parent via `inheritParentMcps: true`.

**Session Log Streaming & Completion** (`session-log.ts`): Reads/tails newline-delimited JSON session logs. Filters messages, summarizes events, detects terminal events. `collectCompletionInfo()` extracts `SessionCompletionInfo`: status (done|failed|interrupted), filesEdited, filesCreated, finalText, error. Supports Claude, Cursor, Codex, and Gemini runtime output formats. Auto-saves agent output to project .claude/ directory via `saveAgentOutput()` with random filenames.

**Session Checkout** (`wrapper-instance.ts:1279-1478`): Validates Claude session ID, blocks concurrent checkouts, SIGTERM→SIGKILL current Claude, launch `--resume` for target.

**Hook Timing** (`wrapper-instance.ts:1001-1023`): Fresh Claude waits 10s for `session-start` hook to link session ID. Hard blocker—throws `E_HOOK_TIMEOUT` on failure.

**Message Resumption** (`wrapper-instance.ts:1119-1202`): Detects missing runtime, restarts resuming prior Claude session.

**Agent Runtime Event Streaming**: Child process outputs newline-delimited JSON events (status→claude-session→done/error). All recorded to DB + log.

**Update Notifications** (`update-watcher.ts`, `wrapper-instance.ts`): Wrapper detects `[UPDATE] <text>` patterns in agent messages and stores them in `agent_updates` table. Parents poll via `UpdateWatcher` service or `klaude watch` command. Supports optional regex filtering and read acknowledgment.

**Automatic Update Injection** (`hook.ts:post-tool-use-updates`): PostToolUse hook fires after every tool use and queries pending child updates, injecting them as context if available. Automatically marks updates as acknowledged to prevent duplication. Works with `*` matcher to ensure coverage across all tool types.

## Socket Protocol

**Newline-delimited JSON**:
- Requests: `{ action: "ping|status|start-agent|checkout|message|interrupt", payload?: object }`
- Responses: `{ ok: boolean, result?: object, error?: { code, message } }`

## Critical Conventions

- **No exclusive locks**: Multiple wrapper instances per project run concurrently
- **Project hash**: SHA-256(root).slice(0, 24) for Unix socket path length constraints
- **Hook env vars**: `KLAUDE_PROJECT_HASH`, `KLAUDE_INSTANCE_ID`, `KLAUDE_SESSION_ID`
- **Agent scopes**: Project agents (`.claude/agents/`) override user agents
- **File tracking**: `collectCompletionInfo()` extracts Write/Edit tool operations; supports delta fragments for streaming output
