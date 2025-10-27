Here’s a pragmatic plan that keeps the wrapper simple, resilient, and compatible with Claude
Code’s TUI constraints (no PTY), while giving you agent orchestration, fast streaming, and
reliable session switching.

Will This Work?

- Yes. Treat Claude Code as a foreground child of a long‑lived wrapper. The wrapper owns the
TTY and launches Claude with stdio=inherit. For “checkout,” the wrapper terminates the current
Claude process and immediately relaunches it with --resume <claude_session_id>.
- Use hooks to track Claude’s native session lifecycle. The wrapper passes an env var (e.g.,
KLAUDE_SESSION_ID) so hooks can associate a new Claude session with the correct Klaude session.
- For agent streaming, run SDK agents as child processes (or tasks) that stream directly to stdout
when invoked via the Claude “Bash” tool, or to per‑agent logs + a Unix socket when detached.
This avoids polling and keeps latency low.

Key Design Principles

- Single TTY owner at any time (the wrapper). No PTY trickery, no background TUIs.
- One wrapper per project (cwd). A per‑project Unix domain socket handles control commands (start,
checkout, interrupt, message).
- Hooks are the source of truth for “what Claude session is current” for each Klaude session. The
wrapper updates the “current Claude session” pointer on SessionStart/End.
- Minimal, evolvable schema: sessions + claude_session_links + runtime_process for PIDs. Logs go
to files; DB stores pointers and metadata.

SQLite Schema

- Goals: durable parent/child tree, map Klaude→Claude sessions, track current PIDs, and keep logs
discoverable.
- Use WAL for safe concurrent writes from wrapper, hooks, and CLI commands.

-- Enable WAL mode once on DB init
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS projects (
id INTEGER PRIMARY KEY,
root_path TEXT NOT NULL UNIQUE,
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One node per agent instance in the tree. Works for TUI and SDK agents.
CREATE TABLE IF NOT EXISTS sessions (
id TEXT PRIMARY KEY,                 -- ULID/UUID (prefer ULID for time-ordering)
project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
agent_type TEXT NOT NULL,            -- 'tui' | 'sdk' | 'worker' (room to grow)
title TEXT,
prompt TEXT,                         -- initial prompt or system prompt
status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'running' | 'done' | 'failed' |
'interrupted'
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at DATETIME,
ended_at DATETIME,
-- fast access fields:
last_claude_session_id TEXT,         -- current Claude session for this node (updated by hooks)
last_transcript_path TEXT,
current_process_pid INTEGER,         -- for SDK agents or active TUI (child PID)
metadata_json TEXT                   -- free-form JSON for options, flags (-c/-s/-d), model, etc
);

-- Every time Claude starts (including /clear), hooks append a row here.
CREATE TABLE IF NOT EXISTS claude_session_links (
id INTEGER PRIMARY KEY,
klaude_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
claude_session_id TEXT NOT NULL UNIQUE,
transcript_path TEXT,
source TEXT,                         -- 'startup' | 'clear' | 'resume' | etc
started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
ended_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_csl_klaude_session_id ON claude_session_links(klaude_session_id);

-- Track long-running processes tied to sessions (wrapper can manage/interrupt).
CREATE TABLE IF NOT EXISTS runtime_process (
id INTEGER PRIMARY KEY,
klaude_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
pid INTEGER NOT NULL,
kind TEXT NOT NULL,                  -- 'wrapper' | 'claude' | 'sdk'
started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
exited_at DATETIME,
exit_code INTEGER,
is_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rp_klaude_session_id ON runtime_process(klaude_session_id);

-- Optional: lightweight event audit trail (for debugging / sessions -v).
CREATE TABLE IF NOT EXISTS events (
id INTEGER PRIMARY KEY,
project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
klaude_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
kind TEXT NOT NULL,                  -- 'hook.session_start' | 'hook.session_end' | 'switch'
| ...
payload_json TEXT,
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

Log layout:

- ~/.klaude/logs/session-<klaude_session_id>.log for text streaming.
- DB only stores last_transcript_path and log paths; “read” just tails files.

Wrapper Architecture

- Process model:
    - Foreground wrapper owns the terminal. It launches Claude as a child with stdio inherited.
    - On “checkout,” wrapper sets a pending resume target, sends SIGTERM to the child Claude,
    waits for exit, then relaunches claude --resume <target_id>.
    - Wrapper listens on a Unix domain socket ~/.klaude/run/<cwd-hash>.sock for control commands
    from klaude <subcommands> executed anywhere (especially from Claude’s Bash tool).
- Environment bridge:
    - When wrapper spawns Claude: set KLAUDE_PROJECT_PATH,
    KLAUDE_SESSION_ID=<current_klaude_session_id>, and KLAUDE_SOCKET=<socket_path>.
    - Hooks rely on these env vars to link Claude session IDs to the correct Klaude session.
- Commands (socket protocol as JSON lines or simple line-based):
    - start: create session row; if attached streaming, run SDK task in this client process to
    stream live to stdout; if -d, ask the wrapper to spawn/manage it (persistent child, writes
    to log + socket).
    - message: route to SDK agent runtime (via session socket or lightweight inbox file the agent
    watches).
    - interrupt: send SIGINT/SIGTERM to the process tracked for that session.
    - checkout [id]: resolve to target session’s latest last_claude_session_id; if missing, wait
    up to N seconds (or fail with guidance). Set pending switch and terminate current Claude.
    - sessions/read: read from DB/files; no wrapper involvement required unless you want live-
    tailing across sockets.
- Lifecycle:
    - Wrapper startup: ensure project row + socket; create/lookup root tui session; launch claude;
    record runtime_process rows.
    - Claude exits:
        - If no pending switch: wrapper exits (propagate exit code).
        - If pending switch: relaunch with --resume and clear the flag.
    - Hook SessionStart: insert claude_session_links row; set sessions.last_claude_session_id for
    the env-provided KLAUDE_SESSION_ID.
    - Hook SessionEnd: mark ended_at for that claude_session_id. If ended session is the current
    one of a Klaude session, you can optionally clear current_process_pid.

Inside-Claude UX (How it Feels)

- User runs klaude in project: wrapper starts Claude TUI.
- From inside Claude’s Bash tool:
    - klaude start <agent_type> "prompt" streams SDK output live into the tool’s output block, and
    also appends to ~/.klaude/logs/session-<id>.log.
    - klaude start ... -d detaches: wrapper manages the SDK agent, streaming to logs and emitting
    socket notifications; tool returns immediately with the new <agent-id>.
    - klaude sessions shows summary with first/last message from logs and the latest Claude
    session id per node.
    - klaude checkout <id> asks wrapper to switch the TUI to the target’s Claude session; wrapper
    kills current Claude, relaunches with --resume, and you land in that conversation.
    - klaude message <id> "prompt" -w sends a message to a detached SDK agent and optionally waits
    for its next output chunk.

Streaming Without Polling

- Attached run (default): the klaude start process itself owns the stream and writes directly to
stdout as events arrive; Claude’s Bash tool shows the stream live.
- Detached run: the wrapper creates an agent runtime process and opens a pair of pipes:
    - Agent writes to a per-session FIFO or Unix socket; wrapper multiplexes to the session log
    and to any connected klaude read -t <id> clients.
    - No polling anywhere; purely event-driven streaming.

Hooks Integration

- Configure hooks in ~/.claude/settings.json to invoke:
    - klaude hook session-start with JSON payload on stdin.
    - klaude hook session-end with JSON payload on stdin.
- Hook behavior:
    - Read payload (cwd, session_id, transcript_path).
    - Read env KLAUDE_SESSION_ID.
    - Upsert claude_session_links and update sessions.last_claude_session_id and
    last_transcript_path for that KLAUDE_SESSION_ID.
    - For /clear, a new row is added and becomes the new last_claude_session_id of the same Klaude
    session node. Parent/child relationships remain intact.

Process Control Details

- Switching:
    - wrapper sets pending_resume_id, sends SIGTERM to current Claude process.
    - Wait up to N seconds; if needed, SIGKILL as fallback (configurable).
    - Relaunch claude --resume <pending_resume_id>, env carries the same KLAUDE_SESSION_ID for
    that target node.
- Interrupt:
    - For TUI: send SIGINT to Claude child PID.
    - For SDK agent: send SIGINT or issue a control message over the agent’s control socket for
    graceful termination.
- Resilience:
    - If hooks are not installed, checkout still works when the target already has a Claude
    session id. If not, print actionable guidance.
    - Use file locks or single-writer discipline for logs; DB in WAL mode handles concurrency
    among wrapper, hooks, and CLI processes.

Config Surface

- ~/.klaude/config.yaml
    - wrapper.claudeBinary default /opt/homebrew/bin/claude
    - wrapper.socketDir default ~/.klaude/run
    - db.path default ~/.klaude/sessions.db
    - logs.dir default ~/.klaude/logs
    - switch.graceSeconds default 1.0
    - stream.timestamp true/false
- Per-project detection via absolute cwd; store projects.root_path canonicalized.

CLI Contract Sketch

- klaude → start wrapper and new root TUI session.
- klaude start <agent_type> <prompt> [count] [-c|--checkout] [-s|--share] [-d|--detach]
    - Create session; if -d: instruct wrapper to run agent runtime and return <agent-id>; else
    stream live and return upon completion; if -c, request checkout to the new session once its
    Claude session exists (wait with backoff; hooks will populate).
- klaude checkout [id] → switch to parent if no id; otherwise to that agent’s
last_claude_session_id.
- klaude message <id> <prompt> [-w|--wait]
- klaude interrupt <id>
- klaude sessions [-v]
- klaude read <id> [-t|--tail] [-s|--summary]
- klaude hook session-start|session-end (reads JSON from stdin)

Edge Cases To Handle

- Race: checkout requested before hook registers the target Claude session id.
    - Solution: checkout waits up to configurable timeout for last_claude_session_id to appear
    (listen on DB change notification via simple retry with jitter or inotify on the DB WAL if
    you want to avoid even tiny polling; practically, a bounded retry with small sleeps is fine
    here).
- Crash in Claude on switch:
    - Wrapper retries launch once; if it fails, surface clear diagnostics and stop.
- Multiple wrappers in same project:
    - Use a per-project lock file for the socket to keep a single owner. If taken, new klaude can
    connect and “focus” instead of spawning.

Why This Is Not Brittle

- Simple control loop: one terminal owner, fixed child flow, explicit switch points.
- Hooks feed a single mapping table; /clear doesn’t break the tree—only updates the “current”
Claude session pointer.
- Detached agents are purely event-driven via sockets/pipes; attached runs stream directly—no
polling anywhere.