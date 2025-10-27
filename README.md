# klaude: A process wrapper for Claude Code with multi-agent session management

A wrapper that spawns Claude Code as a subprocess and manages multiple agent sessions with seamless context switching. Enables delegating work to specialized agents while maintaining stateful session history. Klaude now tracks Claude Code's native session identifiers so `--resume` always targets the correct conversation.

## Quick Start

```bash
cd your-project
klaude
```

This launches Claude Code inside a wrapper. Inside Claude, you can:

```bash
klaude start orchestrator "build auth system"
klaude sessions
enter-agent <agent-id>  # switch to another agent
```

The wrapper uses marker files and process signals to handle session switching seamlessly. When agents run, Klaude records both its internal session ID _and_ Claude Code's session ID; the latter is what the wrapper uses for `--resume`.

### Claude Binary Path

Set the path to the Claude Code executable with `CLAUDE_BINARY` (or `KLAUDE_CLAUDE_BINARY`). You can also persist it by editing `~/.klaude/config.yaml` and setting `wrapper.claudeBinary`. The default points to `/opt/homebrew/bin/claude`.

## Architecture

**User runs `klaude` with no args** → Wrapper spawns Claude Code subprocess → User interacts with Claude normally, but can now spawn/manage agents

**Inside Claude**, commands like `klaude start`, `enter-agent`, etc. communicate with the wrapper via:
- `.next-session` marker files (for session switching)
- Process signals (SIGTERM to trigger switch detection)
- SQLite registry (`~/.klaude/sessions.db`) tracking all sessions

## State & Storage

~/.klaude/
  ├── sessions.db         # SQLite for session metadata + linked Claude session IDs
  ├── logs/
  │    ├── session-123.log
  │    ├── session-124.log
  ├── config.yaml
  ├── .active-pids.json   # Track running Claude Code processes
  ├── .next-session       # Marker file for session switching
  └── .wrapper-pid        # Wrapper process ID

## Commands

All commands work from _within_ the Claude Code process (inside the wrapper). Many are meant to be run by Claude Code itself for multi-agent orchestration.

```
klaude <command> [options]
```

Commands:
  klaude start <agent_type> <prompt> [agent_count] [options]
    Description: Delegates an agent of that type to perform the task. Agent prompt is appended with instructions on updating the parent. Streams response back to the terminal, but also saved in klaude session.
    Options:
      -c, --checkout  Checks out the agent immediately after starting, without interrupting it.
      -s, --share     Shares current context (last X messages) with the new agent.
      -d, --detach    Start without streaming back output (for daemonized agents).
    Returns: The process and session ID of the started agent.

  klaude checkout [id]
    Description: Interrupts the current agent (cli), exits it, then enters the specified agent's session without interrupting the target agent. If no ID is provided, enters parent agent, if it exists.

  klaude message <id> <prompt> [options]
    Description: Sends an asynchronous message to the specified agent.
    Options:
      -w, --wait      Blocks until the agent responds to the message (max 30 seconds)

  klaude interrupt <id>
    Description: Interrupts the specified agent's current operation.

  klaude sessions [options]
    Description: Views active klaude sessions, showing a brief description, first, and last message for each.
    Options:
      -v              Displays more detailed information for each session.

  klaude read <id> [options]
    Description: Reads the full response logs for the specified session.
    Options:
      -t, --tail      Tails the logs (tail -f style)
      -s, --summary   Summarize the session

Klaude is stateful—session data persists in SQLite after you exit. You can resume or inspect previous sessions later.

## How Session Switching Works

1. User calls `enter-agent <agent-id>` from within Claude
2. `enter-agent` writes `.next-session` marker file with the target Claude session ID
3. `enter-agent` kills the current Claude process (SIGTERM)
4. Wrapper detects the process exit and sees the marker file
5. Wrapper spawns Claude again with `--resume <claude-session-id>`
6. User is now in the other agent's session (Klaude keeps its own session IDs for internal bookkeeping)

This enables seamless multi-agent context switching without data loss.

## Hook Integration

Klaude ships a `hook` subcommand so Claude Code can keep the session database up to date when the TUI starts, clears, or ends conversations. Install the hooks in your Claude settings (e.g. `~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "klaude hook session-start" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "klaude hook session-end" }
        ]
      }
    ]
  }
}
```

With these hooks enabled, Klaude automatically records brand-new Claude sessions (including those created via `/clear`) and marks them completed when they end. This keeps parent/child relationships intact so `klaude checkout` and agent cleanup work reliably.

## Planned Features
- Proper agent subprocess spawning (currently DB skeleton)
- Interactive wrapper loop in TypeScript
- CLI integration within Claude Code sessions
- API layer for non-interactive integrations

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Detailed notes on the session-switching mechanism, bash implementation, and TypeScript re-implementation requirements. Read this before implementing the wrapper in TypeScript. 
