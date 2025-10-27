# Klaude CLI - Session Management & Agent Delegation

TypeScript CLI wrapper for Claude Code that enables multi-agent session management and seamless context switching. Core implementation of the workflow orchestration system.

## Build/Development/Testing

**Build**:
```bash
npm run build      # TypeScript compile + tsc-alias + global npm link
npm run dev        # Watch mode (tsc --watch)
npm run clean      # Remove dist directory
```

**Linting/Formatting**:
```bash
npm run lint       # ESLint
npm run format     # Prettier
```

**Testing**:
```bash
npm run test              # Vitest
npm run test:coverage     # Vitest with coverage
```

## Project Structure

```
src/
├── config/
│   ├── constants.ts      # Global constants (paths, env vars, timeouts)
│   └── defaults.ts       # Default configuration values
├── db/
│   └── database.ts       # SQLite session registry operations
├── services/
│   ├── config-loader.ts  # YAML config loading (~/.klaude/config.yaml)
│   ├── logger.ts         # Structured logging to session logs
│   └── message-queue.ts  # Async message passing between sessions
├── types/
│   └── index.ts          # TypeScript interfaces (Session, Agent, Config)
├── utils/
│   ├── error-handler.ts  # Centralized error handling
│   └── path-helper.ts    # Path resolution (~/.klaude)
└── commands/             # CLI command implementations
    ├── start.ts          # `klaude start <agent> <prompt>`
    ├── checkout.ts       # `klaude checkout [id]`
    ├── sessions.ts       # `klaude sessions`
    ├── message.ts        # `klaude message <id> <prompt>`
    ├── read.ts           # `klaude read <id>`
    ├── interrupt.ts      # `klaude interrupt <id>`
    └── hook.ts           # Claude Code hook integration
└── index.ts              # CLI entry point (Commander setup)
```

## Core Architecture

**Session Model**:
- Klaude maintains SQLite registry at `~/.klaude/sessions.db`
- Each session has: `id` (internal), `claudeSessionId` (linked), `parentId`, `agentType`, `prompt`, `status`
- Claude Code subprocess runs inside wrapper; agent switching via signal handling

**State Storage** (`~/.klaude/`):
- `sessions.db`: Session metadata + linked Claude session IDs
- `logs/`: Per-session log files (session-{id}.log)
- `config.yaml`: User configuration (wrapper.claudeBinary, etc.)
- `.active-pids.json`: Track running Claude Code processes
- `.next-session`: Marker file for session switching
- `.wrapper-pid`: Wrapper process ID

**Session Switching Flow**:
1. `enter-agent <id>` writes `.next-session` marker with Claude session ID
2. Kills current Claude process (SIGTERM)
3. Wrapper detects exit, reads marker, spawns Claude with `--resume <claudeSessionId>`
4. User seamlessly enters other agent's session

## Key Commands

**Spawning Agents** (from within Claude):
```bash
klaude start orchestrator "build auth system"  # Spawn orchestrator agent
klaude start planner <id> "create plan"        # Spawn specific agent type
```

**Session Navigation**:
```bash
klaude sessions          # List all active sessions
klaude checkout [id]     # Switch to agent session
enter-agent <agent-id>   # Shorthand for session switching
```

**Async Communication**:
```bash
klaude message <id> <prompt> --wait  # Send message, wait for response
```

**Session Inspection**:
```bash
klaude read <id> --tail       # Stream session logs
klaude read <id> --summary    # Summarize session activity
```

## Code Conventions

**TypeScript**:
- Strict mode enabled (tsconfig.json)
- No `any` types—always define explicit interfaces
- Error handling via `error-handler.ts` utility (early throwing)

**CLI Structure** (Commander):
- Each command in `src/commands/` as separate module
- Export default handler function: `export default async (args: Args) => Promise<Result>`
- Register in `index.ts` via `program.command().action()`

**Database Access**:
- All queries through `db/database.ts` (SQL.js wrapper)
- Transactions for multi-operation consistency
- Log all schema changes in `defaults.ts`

**Logging**:
- Use `logger.ts` for structured output to session logs
- Console output via `chalk` for colored terminal output
- Never log credentials or sensitive data

**Path Resolution**:
- Always use `path-helper.ts` for `~/.klaude` paths
- Handles cross-platform path construction

## Git Integration

- Post-commit hook NOT applied to this directory (implementation-specific)
- CLAUDE.md managed manually for this tooling repository
- Agent documentation tracked in parent `/agents/` directory

## Testing

- Vitest for unit tests
- Test files colocated: `src/commands/__tests__/start.test.ts`
- Focus on: database transactions, CLI parsing, session switching logic
