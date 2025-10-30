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
- **task** – Blocks Task tool in Klaude sessions, redirects to `klaude start` with `--attach`/`--detach` options
- **pre-user-message** – Detects `@agent-` pattern in user messages, delegates to agent system

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

## Error Handling

All commands wrap in `try/catch` → `KlaudeError` → `printError()`. Errors are **not thrown back to CLI** (Commander doesn't exit cleanly); instead, error state is printed and process exits via service/DB error.
