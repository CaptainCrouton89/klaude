# CLI Command Handlers (`src/commands/`)

Command implementations that register with Commander and delegate to services.

## Pattern

Each file exports `register{Name}Command(program: Command)` that:
1. Calls `program.command()` to register with Commander
2. Chains `.argument()`, `.option()`, `.action()`
3. In action, resolves project context via `resolveProjectDirectory()`
4. Delegates core logic to services (`instance-client`, `session-log`, etc.)
5. Catches `KlaudeError` and prints via `printError()`

## Hook Commands (`hook.ts`)

Special internal hook commands invoked by Claude via configured hooks. All read JSON payload from stdin, log to `/tmp/klaude-hook.log` with timestamps, and return JSON response (if applicable):

- **session-start** – Links Claude session ID to Klaude session in DB (enables `--resume` checkout)
- **session-end** – Cleans up session state when Claude exits
- **task** – Blocks Task tool in Klaude sessions; exempts `Plan`, `Explore`, `claude-code-guide` agents (allowed native Task tool). Redirects to `klaude start <agent> "<prompt>"`
- **pre-user-message** – Detects `@agent-` pattern in user messages, delegates to agent system
- **post-tool-use-updates** – Queries pending child agent updates after every tool use, formats with session metadata (timestamp, agent type, session suffix), injects as context block, auto-acknowledges updates

Hooks include detailed error codes and elapsed time in logs. Non-fatal errors don't block tool use (post-tool-use-updates, pre-user-message).

## Start Command (`start.ts`)

Starts new agent sessions with agent-friendly output (abbreviated session IDs, concise "Next steps" hints):

```bash
klaude start <agentType> "<prompt>"           # Start agent
klaude start <agentType> "<prompt>" <count>   # Fan-out with agent count
klaude start <agentType> "<prompt>" --share   # Share current context
klaude start <agentType> "<prompt>" -v        # Verbose mode (instance, log path)
```

Help text adjusts by runtime kind: Cursor sessions hide checkout/message commands. Parent session ID resolved via `KLAUDE_SESSION_ID` env var. Accepts unrecognized options (e.g., `--timeout` from Task tool).

## Shared Utilities

- `resolveProjectDirectory(options.cwd)` – Project path resolution
- `prepareProjectContext(cwd)` – Load project hash, DB, config
- `abbreviateSessionId(id)` – Last 6 chars of ULID for concise output
- `resolveSessionId(abbreviated, projectId)` – Resolve abbreviated ID to full ULID
- `KlaudeError` + `printError()` – Error handling
- `resolveInstanceForProject()` – Get active wrapper instance for project

## Service Delegation

- **instance-client** – `startAgentSession()`, `requestCheckout()`, `sendMessage()`, `interruptSession()`
- **session-log** – `collectCompletionInfo()`, `saveAgentOutput()`, `readSessionLog()`, `tailSessionLog()`, `summarizeSessionLog()`
- **db** – Query sessions, instances, events, agent updates (via CRUD methods)
- **project-context** – Config loading, agent discovery
- **agent-definitions** – Load agent YAML metadata (including `outputDir` config)
- **hooks/session-hooks** – Handle hook payloads (`handleSessionStartHook()`, etc.)

## Wait Command (`wait.ts`)

Blocks until one or more agent sessions reach terminal state (`done`, `failed`, `interrupted`):

```bash
klaude wait <sessionId...>           # Wait for all sessions to complete
klaude wait <sessionId> --any        # Return when ANY session completes
klaude wait <sessionId> --timeout 60 # Max wait time (default: 570s)
klaude wait <sessionId> --interval 500 # Poll interval in ms (default: 500)
```

Displays completion summary per session: edited/created files, agent output (if `outputDir` configured in agent definition). Saves agent output to `outputDir` if session succeeds. Supports abbreviated session IDs. Exit codes: 0 (success), 1 (error), 124 (timeout).

## Watch Command (`watch.ts`)

Monitor real-time `[UPDATE]` messages from child agent sessions:

```bash
klaude watch <session-id>              # Watch all updates from children
klaude watch <session-id> --once       # Poll once and exit
klaude watch <session-id> --filter "error"  # Filter by regex pattern
klaude watch <session-id> --acknowledge # Mark updates as read after display
klaude watch <session-id> --interval 5 # Poll every 5 seconds (default: 3)
```

Continuous polling from DB for unacknowledged updates. Color-coded output (agent type, session ID, timestamp). Non-blocking (parent can continue work). Used by orchestrators, TUIs, and parent agents via standalone command or `UpdateWatcher` service.

## Error Handling

All commands wrap in `try/catch` → `KlaudeError` → `printError()`. Errors are **not thrown back to CLI** (Commander doesn't exit cleanly); instead, error state is printed and process exits via service/DB error.
