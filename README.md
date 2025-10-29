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

Agent types are dynamically loaded from your agents directory (e.g., `~/.claude/agents/` or `./.claude/agents/`). Any agent definition available there can be used with `klaude start`.

The wrapper handles session switching seamlessly. When agents run, Klaude records both its internal session ID _and_ Claude Code's session ID; the latter is what the wrapper uses for `--resume`.

### Claude Binary Path

`~/.klaude/config.yaml` has setting `wrapper.claudeBinary`. The default points to `/opt/homebrew/bin/claude`.

## Architecture

**User runs `klaude` with no args** → Wrapper spawns Claude Code subprocess → User interacts with Claude normally, but can now spawn/manage agents

**Inside Claude**, commands like `klaude start`, `enter-agent`, etc. communicate with the wrapper. This wrapper is helpful because it can manage the TUI itself, force-interrupting it and then automatically starting a new TUI with a new agent spawned by claude code.

## State & Storage

~/.klaude/
  ├── sessions.db         # SQLite for session metadata + linked Claude session IDs
  ├── logs/
  │    ├── session-123.log
  │    ├── session-124.log
  ├── config.yaml

## Commands

All commands work from _within_ the Claude Code process (inside the wrapper). Many are meant to be run by Claude Code itself for multi-agent orchestration.

```
klaude <command> [options]
```

Commands:
  klaude
    Description: Starts the wrapper for that directory and creates a brand new TUI claude code agent as the root.
  klaude start <agent_type> <prompt> [agent_count] [options]
    Description: Spawns an agent (type loaded from agents directory) to perform the task. Agent prompt is appended with instructions on updating the parent. Streams response back to the terminal continuously, but also saved in klaude session.
    Agent Type: Name of any agent definition in your agents directory (e.g., `orchestrator`, `programmer`, `context-engineer`, or custom agents).
    Options:
      -c, --checkout  Checks out the agent immediately after starting, without interrupting it.
      -s, --share     Shares current context (last X messages) with the new agent.
      -d, --detach    Start without streaming back output (for daemonized agents).
    Returns: The process and session ID of the started agent.

  klaude checkout [id]
    Description: Interrupts the current agent (cli), exits it, then enters the specified agent's session without interrupting the target agent. If no ID is provided, enters parent agent.

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

## MCP Server Configuration

Agents can be configured with specific MCP (Model Context Protocol) servers, giving them access to different tools and data sources. MCPs are configured at two levels:

### Global MCP Registry

Define available MCP servers in `~/.klaude/config.yaml` or project `.mcp.json`:

**~/.klaude/config.yaml:**
```yaml
mcpServers:
  sql:
    type: stdio
    command: npx
    args: [-y, '@modelcontextprotocol/server-postgres']
    env:
      DATABASE_URL: postgresql://localhost/mydb
  json:
    type: stdio
    command: npx
    args: [-y, '@anthropic-ai/mcp-json']
  github:
    type: http
    url: https://api.githubcopilot.com/mcp/
```

**Project `.mcp.json`** (standard Claude Code format):
```json
{
  "mcpServers": {
    "company-api": {
      "type": "stdio",
      "command": "/usr/local/bin/company-mcp",
      "args": ["--config", "./mcp-config.json"]
    }
  }
}
```

### Per-Agent MCP Configuration

Agents can specify which MCPs they need in their frontmatter:

```markdown
name: Database Analyst
description: Analyzes SQL databases and JSON data
mcpServers: sql, json
inheritProjectMcps: false
inheritParentMcps: false
allowedAgents: junior-engineer

Agent instructions here...
```

**Frontmatter Fields:**
- `mcpServers`: Comma-separated list of MCP names from the registry
- `inheritProjectMcps`: Inherit all MCPs from project `.mcp.json` (default: true)
- `inheritParentMcps`: Inherit parent agent's MCPs (default: false)

**Resolution Logic:**
1. If `mcpServers` is specified → Use ONLY those MCPs (explicit override)
2. Otherwise:
   - If `inheritProjectMcps !== false` → Start with all project MCPs
   - If `inheritParentMcps === true` → Add parent's MCPs

**Examples:**

```markdown
# Agent with specific MCPs only
mcpServers: sql, json
inheritProjectMcps: false
```

```markdown
# Agent inheriting project defaults plus parent's MCPs
inheritProjectMcps: true
inheritParentMcps: true
```

```markdown
# Agent with project defaults but not parent's MCPs (default behavior)
inheritProjectMcps: true
inheritParentMcps: false
```