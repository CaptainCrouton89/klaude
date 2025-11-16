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

Special internal hook commands invoked by Claude via configured hooks:

- **session-start** – Links Claude session ID to Klaude session in DB (enables `--resume` checkout)
- **session-end** – Cleans up session state when Claude exits
- **task** – Blocks Task tool in Klaude sessions, redirects to `klaude start` with options (`--share`). Exempts `Plan` and `Explore` agents (allowed to use native Task tool)
- **pre-user-message** – Detects `@agent-` pattern in user messages, delegates to agent system
- **post-tool-use-updates** – Queries pending child agent updates after every tool use and injects them as context. Matches all tools via `*` matcher. Auto-acknowledges updates after injection.

All hooks read JSON payload from stdin, log to `/tmp/klaude-hook.log`, and return JSON response (if applicable).

## Shared Utilities

- `resolveProjectDirectory(options.cwd)` – Project path resolution
- `prepareProjectContext(cwd)` – Load project hash, DB, config
- `KlaudeError` + `printError()` – Error handling
- `resolveInstanceForProject()` – Get active wrapper instance for project

## Service Delegation

- **instance-client** – `startAgentSession()`, `requestCheckout()`, `sendMessage()`, `interruptSession()`
- **session-log** – `tailSessionLog()`, `readSessionLog()`, `summarizeSessionLog()`
- **db** – Query sessions, instances, events (via CRUD methods)
- **project-context** – Config loading, agent discovery
- **hooks/session-hooks** – Handle hook payloads (`handleSessionStartHook()`, `handlePreUserMessageHook()`, etc.)

## Watch Command (`watch.ts`)

Monitor and display real-time `[UPDATE]` messages from child agent sessions:

```bash
klaude watch <session-id>              # Watch all updates from children
klaude watch <session-id> --once       # Poll once and exit
klaude watch <session-id> --filter "error"  # Filter by regex pattern
klaude watch <session-id> --acknowledge # Mark updates as read after display
klaude watch <session-id> --interval 5 # Poll every 5 seconds (default: 3)
```

**Features:**
- Continuous polling from DB for unacknowledged updates
- Regex pattern filtering for selective updates
- Color-coded output (agent type, session ID, timestamp)
- Optional acknowledgment flag to track read status
- Non-blocking (parent can continue work)

**Integration:**
- Queries `agent_updates` table via DB models
- Used by orchestrators, TUIs, and parent agents
- Standalone command or via `UpdateWatcher` service for callbacks

## Error Handling

All commands wrap in `try/catch` → `KlaudeError` → `printError()`. Errors are **not thrown back to CLI** (Commander doesn't exit cleanly); instead, error state is printed and process exits via service/DB error.
