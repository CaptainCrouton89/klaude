# klaude CLI: A wrapper for Claude Code interactive CLI

Usable by both the user and by Claude, this wrapper lets you and Claude spin up agents in the same workspace. Agents in the workspace know about each other.

Keep log of active sessions, can go back to previous sessions

	•	Later: Add a CLI API layer (like klaude api) to let you query Claude directly without state — e.g., scripting integrations.

~/.klaude/
  ├── sessions.db         # SQLite for session metadata
  ├── logs/
  │    ├── session-123.log
  │    ├── session-124.log
  ├── config.yaml


The following commands only work from _within_ the klaude wrapper, which keeps all of the session information together. Many of these commands are meant to be run by Claude Code itself, so it can manage and communicate with other instances.

## Commands

klaude <command> [options]

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

Klaude is stateful, so after running "/exit", the state is saved.

## Stretch Goals
- API—allow other services to interact with kluade
- 