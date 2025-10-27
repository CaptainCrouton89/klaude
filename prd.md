# Klaude PRD: Multi‑Agent Wrapper for Claude Code

Status: draft-2
Owner: Klaude core
Scope: Wrapper + hooks + session DB + CLI contract

## Goals

- Orchestrate multiple agents while using Claude Code’s native TUI.
- Enable seamless checkout between agents by resuming their Claude session.
- Maintain a durable parent/child session tree with linked Claude session IDs.
- Provide low‑latency streaming from agents (no polling) and durable logs.
- Support concurrent usage across multiple project directories.
- Support multiple Klaude instances in the same project directory (e.g., two terminals), each with its own active Claude TUI and sessions, without interference.

## Non‑Goals

- No PTY emulation. Each wrapper instance owns its terminal TTY and spawns Claude in the foreground.
- No hidden fallbacks: fail fast with clear errors and explicit flags for waits/retries.
- No attempt to multiplex multiple TUIs simultaneously in one terminal.

## Hard Constraints (Feedback‑driven)

- No fallbacks: do not silently retry or use alternative flows. If a switch/launch cannot proceed, return a clear error (with code) and guidance. Explicit flags can enable waits.
- Attached and detached agents behave uniformly at the data layer: both are registered, stream events to the same pipeline, and write to the same logs/DB so the main agent can query later.
- Multiple directories concurrently: allow multiple wrappers running at the same time for different project roots without interference.
- Multiple instances per project concurrently: allow multiple wrappers running at the same time in the same project without interference.

## High‑Level Architecture

- Process model
  - Foreground wrapper instance owns its terminal (TTY) and runs independently of other instances, even within the same project.
  - Each instance launches a dedicated Claude Code child with stdio inherited for that terminal.
  - For checkout, an instance terminates its own Claude child and launches `claude --resume <claude_session_id>` for its target session.
- Control plane
  - Per‑project run directory: `~/.klaude/run/<projectHash>/`.
  - Per‑instance Unix domain socket: `~/.klaude/run/<projectHash>/<instanceId>.sock`.
  - Per‑project instance registry file: `~/.klaude/run/<projectHash>/instances.json` with advisory locking for updates.
  - CLI subcommands connect to a specific instance socket for process control operations (start, checkout, interrupt, message); project‑scoped read‑only queries (sessions, read) go directly to the DB/logs and do not require instance selection.
- Hooks
  - Claude hooks call `klaude hook session-start|session-end` with JSON payload on stdin.
  - Hooks use env `KLAUDE_PROJECT_HASH` and `KLAUDE_SESSION_ID` to associate native Claude sessions to Klaude sessions; `KLAUDE_INSTANCE_ID` is included for provenance but not required for correctness.
- State
  - Single SQLite DB at `~/.klaude/sessions.db` (WAL mode) shared by all projects and instances.
  - Logs per project: `~/.klaude/projects/<projectHash>/logs/session-<klaude_session_id>.log`.
  - Transcripts are referenced by path from Claude’s hook payloads; we store pointers.
  - Instance presence and metadata recorded in both the per‑project registry file and an `instances` table in the DB for auditing and cleanup.

## Identifiers

- `projectHash`: `hex(sha256(canonicalProjectRootPath))` (canonicalized path; symlinks resolved).
- `instanceId`: ULID generated at instance start; unique per wrapper instance.
- `sessions.id`: ULID as TEXT for human‑sortable time ordering.
- Claude session IDs are stored verbatim from hooks.

## Wrapper Lifecycle

1. Start (`klaude` with no subcommand)
   - Resolve project root to canonical path; derive `projectHash`.
   - Starting `klaude` always creates a new wrapper instance scoped to this directory, regardless of other instances.
   - Generate `instanceId`; create per‑instance socket; register instance in `instances.json` and DB; no exclusive project lock is taken.
   - Ensure project directories and DB; set WAL mode.
   - Create a root `tui` session owned by this instance; export env:
     - `KLAUDE_PROJECT_HASH=<...>`
     - `KLAUDE_INSTANCE_ID=<instanceId>`
     - `KLAUDE_SESSION_ID=<root_klaude_session_id>`
   - Launch `claude` (binary path from config) in foreground on this terminal.

2. Checkout (per‑instance)
   - CLI sends `checkout { targetKlaudeSessionId }` to a specific instance (default: the instance associated with current shell via `KLAUDE_INSTANCE_ID`; otherwise via `--instance`).
   - Instance resolves the target’s `last_claude_session_id`. If missing:
     - If `--wait <seconds>` provided, wait up to the timeout for hooks to populate; else fail `E_SWITCH_TARGET_MISSING`.
   - Send SIGTERM to this instance’s current Claude child; wait `graceSeconds` (config). If still alive, send SIGKILL.
   - Launch `claude --resume <last_claude_session_id>` with env `KLAUDE_SESSION_ID=<targetKlaudeSessionId>`.

3. Attached vs Detached `start` (per‑instance control)
   - Always spawn an agent runtime process managed by the addressed instance (uniform model across instances).
   - For attached starts, the CLI attaches to the runtime’s event stream over the instance socket and mirrors it to stdout; runtime persists and keeps writing to log.
   - For detached starts, CLI returns immediately after session creation; runtime continues in background writing to log and broadcasting events.

4. Exit
   - If Claude exits and no pending switch, the instance exits with child’s code, unregisters from `instances.json` and marks itself ended in DB.

## Hooks

Install in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "klaude hook session-start" }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "command", "command": "klaude hook session-end" }]
    }]
  }
}
```

Hook input (stdin JSON example):

```json
{
  "cwd": "/abs/project/root",
  "hook_event_name": "SessionStart",
  "session_id": "10ad1de4-...",
  "source": "startup",
  "transcript_path": "/Users/.../.claude/projects/-Users-.../10ad1de4-....jsonl"
}
```

Required env from wrapper when spawning Claude:

- `KLAUDE_PROJECT_HASH`
- `KLAUDE_INSTANCE_ID`
- `KLAUDE_SESSION_ID` (Klaude session node this TUI belongs to)

Hook behavior:

- `session-start`:
  - Insert row in `claude_session_links`.
  - Update `sessions.last_claude_session_id` and `sessions.last_transcript_path` for `KLAUDE_SESSION_ID`.
  - Append event.
- `session-end`:
  - Mark `claude_session_links.ended_at` for the native `session_id`.
  - Append event.

If hooks are not installed, Claude will run, but operations that require a native session id (e.g., `checkout`) will fail fast with explicit error `E_SWITCH_TARGET_MISSING` unless `--wait` is provided.

## SQLite Schema

Initialization pragmas (run once at DB creation):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

Schema:

```sql
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  project_hash TEXT NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,              -- ULID
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pid INTEGER NOT NULL,
  tty TEXT,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  exit_code INTEGER,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_instances_project ON instances(project_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                    -- ULID
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_type TEXT NOT NULL,               -- 'tui' | 'sdk' | 'worker'
  instance_id TEXT REFERENCES instances(instance_id) ON DELETE SET NULL,
  title TEXT,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'running' | 'done' | 'failed' | 'interrupted'
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  ended_at DATETIME,
  last_claude_session_id TEXT,
  last_transcript_path TEXT,
  current_process_pid INTEGER,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_instance ON sessions(instance_id);

CREATE TABLE IF NOT EXISTS claude_session_links (
  id INTEGER PRIMARY KEY,
  klaude_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  claude_session_id TEXT NOT NULL UNIQUE,
  transcript_path TEXT,
  source TEXT,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_csl_klaude ON claude_session_links(klaude_session_id);

CREATE TABLE IF NOT EXISTS runtime_process (
  id INTEGER PRIMARY KEY,
  klaude_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pid INTEGER NOT NULL,
  kind TEXT NOT NULL,                     -- 'wrapper' | 'claude' | 'sdk'
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exited_at DATETIME,
  exit_code INTEGER,
  is_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runtime_klaude ON runtime_process(klaude_session_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  klaude_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                     -- 'hook.session_start' | 'hook.session_end' | 'start' | 'switch' | ...
  payload_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
```

Notes:

- Both attached and detached runs create entries in `sessions` and `runtime_process`, and write to the same per‑session log.
- Logs are immutable append; DB stores pointers and status.

## Logs and Streaming

- Directory layout: `~/.klaude/projects/<projectHash>/logs/`.
- File per session: `session-<klaude_session_id>.log`.
- Attached and detached agents stream events identically into the log.
- Event bus: each instance exposes per‑session event channels over its instance socket. Clients may `read -t` to tail in real‑time (no polling) from the addressed instance. DB/log tail remains instance‑agnostic.

## CLI Contract

- `klaude`
  - Starts a new wrapper instance for the current project directory. Multiple instances may run concurrently in the same project.

- `klaude start <agent_type> <prompt> [agent_count] [options]`
  - Options: `-c, --checkout`, `-s, --share`, `-d, --detach`, `--instance <id>`.
  - Behavior: always create a session and runtime in the addressed instance; if attached (default), attach to the runtime stream; if detached, return immediately with the new session id.

- `klaude checkout [id] [--instance <id>]`
  - If no `id`, target is the parent of the current session (if any) within the addressed instance. Requires that the target has a `last_claude_session_id`.
  - If missing and `--wait <seconds>` not provided, error `E_SWITCH_TARGET_MISSING`.

- `klaude message <id> <prompt> [-w, --wait] [--instance <id>]`
  - Send to agent’s runtime channel in the addressed instance; optional wait for next output chunk (bounded by flag value). If no runtime is active, error `E_AGENT_NOT_RUNNING`.

- `klaude interrupt <id> [--instance <id>]`
  - Sends SIGINT/SIGTERM to the runtime for that session in the addressed instance.

- `klaude sessions [-v]`
  - Lists sessions in the current project (instance‑agnostic) with first/last message summaries.

- `klaude read <id> [-t, --tail] [-s, --summary] [--instance <id>]`
  - Reads from the per‑session log; `--tail` attaches to the live event channel on the addressed instance if the session is running; without `--instance`, falls back to DB/log tail only.

- `klaude instances`
  - Lists active instances for the current project with `instanceId`, pid, started_at, and TTY.

- `klaude hook session-start|session-end`
  - Reads JSON on stdin; requires `KLAUDE_PROJECT_HASH` and (for TUI) `KLAUDE_SESSION_ID`; includes `KLAUDE_INSTANCE_ID` when available.

## Process Control

- Termination policy
  - Switch: SIGTERM, wait `switch.graceSeconds` (default 1.0), then SIGKILL. This is not a fallback; it is enforced termination.
  - No auto‑relaunch retries. If relaunch fails, return `E_CLAUDE_LAUNCH_FAILED` with stderr output.

- Interrupt policy
  - TUI: SIGINT to Claude child of the addressed instance.
  - SDK agents: SIGINT to process or control message for graceful stop.

## Config

File: `~/.klaude/config.yaml`

```yaml
wrapper:
  claudeBinary: /opt/homebrew/bin/claude
  socketDir: ~/.klaude/run
  projectsDir: ~/.klaude/projects
  switch:
    graceSeconds: 1.0
db:
  path: ~/.klaude/sessions.db
stream:
  timestamp: true
defaults:
  instanceSelection: auto           # 'auto' uses KLAUDE_INSTANCE_ID when present; if ambiguous, prompt or require --instance
```

## Error Model (selected)

- `E_SWITCH_TARGET_MISSING` – target Klaude session has no Claude session id; use `--wait` or ensure hooks.
- `E_AGENT_NOT_RUNNING` – message/interrupt for a session without an active runtime.
- `E_CLAUDE_LAUNCH_FAILED` – Claude process failed to start; includes captured stderr.
- `E_SOCKET_UNAVAILABLE` – cannot connect to instance socket.
- `E_INSTANCE_NOT_FOUND` – no matching instance; specify `--instance` or start one.
- `E_AMBIGUOUS_INSTANCE` – multiple candidate instances; specify `--instance` explicitly.

## Concurrency and Multi‑Project

- Multiple wrappers per project (no exclusive lock). Multiple instances across the same project run concurrently without interference.
- Shared SQLite DB in WAL mode tolerates concurrent writers across projects and instances.
- All per‑project artifacts (logs, sockets, registry) are namespaced by `projectHash`; per‑instance sockets by `instanceId`.
- Instance registry enables discovery and cleanup of stale sockets (PIDs reaped and entries marked ended).

## Attached vs Detached: Uniform Data Path

- Session creation, runtime process, log append, event broadcast happen identically for both modes.
- Attached mode adds a client attachment to the stream of the addressed instance; detached mode returns immediately.
- This guarantees the parent can query or tail later with `read -t` or inspect with `sessions -v`.

## Instance Discovery and Targeting

- Default targeting uses `KLAUDE_INSTANCE_ID` exported by the instance you started in the current shell.
- If `KLAUDE_INSTANCE_ID` is not present and more than one instance exists for the project, commands that require an instance fail with `E_AMBIGUOUS_INSTANCE` unless `--instance` is provided.
- Instance discovery uses `~/.klaude/run/<projectHash>/instances.json`; stale entries are ignored when PID does not exist.

## Decisions on Prior Open Questions

- `klaude` without subcommand always starts a new wrapper instance in the current directory, even if others are already running. Wrappers in other directories run independently.
- `--wait` default: checkout/message style commands default to `--wait 5`. Users can request immediate failure with `--wait 0` or longer waits explicitly.
