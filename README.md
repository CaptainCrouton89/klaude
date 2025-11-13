# 🤖 Klaude

> **A powerful process wrapper for Claude Code with multi-agent session management**

Klaude spawns Claude Code as a subprocess and manages multiple specialized agent sessions with seamless context switching. Delegate work to specialized agents while maintaining stateful session history. Klaude tracks Claude Code's native session identifiers so `--resume` always targets the correct conversation.

## 📦 Installation

### Global Install (Recommended)

```bash
npm install -g klaude
```

This installs `klaude` globally, making it available as a command from any directory.

### ⚙️ Setup

**After installation, run the setup command:**

```bash
klaude setup-hooks
```

This installs git hooks into your `~/.claude/settings.json` that enable session management and context switching. **This is required for multi-agent workflows to function properly.**

#### Built-in Agents

During setup, you'll be prompted to install built-in agents:

| Agent | Purpose |
|-------|---------|
| **programmer** | Complex multi-file implementations requiring pattern analysis |
| **junior-engineer** | Focused implementation of well-specified tasks |
| **context-engineer** | Codebase exploration and pattern discovery |
| **senior-architect** | Technical review and architectural guidance |

The built-in agents are optional and will be copied to `~/.claude/agents/` only if you confirm. They serve as examples you can customize or use as-is.

### 🔧 Local Development

For development or local use in a project:

```bash
npm install
npm run build
npm link
klaude setup-hooks
```

#### 📝 Note for pnpm users

`better-sqlite3` requires native compilation. If you get a "Could not locate the bindings file" error:

**Option 1: Manual build**
```bash
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
npm run build-release
```

**Option 2: Configure pnpm** (add to `.npmrc`)
```ini
enable-pre-post-scripts=true
```

## 🚀 Quick Start

### Starting Klaude from Terminal

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

### Using Klaude from Within Claude Code

Claude Code itself can invoke klaude to spawn specialized agents for delegated work. For example:

> "Use klaude to start a programmer agent to implement the authentication system."

This spawns an agent in the background while you continue your conversation.

#### Key Commands

| Command | Description |
|---------|-------------|
| `klaude start <agent-type> "<task>"` | Create a new agent to work on a task |
| `klaude sessions` | View all active agents and their status |
| `enter-agent <session-id>` | Switch to another agent's session |
| `klaude checkout <session-id>` | Jump to another agent's session |
| `klaude message <session-id> "<msg>"` | Send asynchronous instruction to an agent |
| `klaude logs <session-id>` | Monitor agent activity in real time |

This enables powerful **multi-agent workflows** where Claude orchestrates specialized agents while maintaining context and coordinating their work.

#### Agent Types

Agent types are dynamically loaded from your agents directory (`~/.claude/agents/` or `./.claude/agents/`). Any agent definition available there can be used with `klaude start`.

The wrapper handles session switching seamlessly. When agents run, Klaude records both its internal session ID _and_ Claude Code's session ID for seamless `--resume` support.

## ⚙️ Configuration

### Claude Binary Path

Configure the Claude binary path in `~/.klaude/config.yaml`:

```yaml
wrapper:
  claudeBinary: /opt/homebrew/bin/claude  # default
```

### Cursor Runtime Retries

`cursor-agent` occasionally exits early when several Composer agents start at once. Klaude automatically retries these startup failures (default: 3 attempts with exponential backoff).

Configure retry behavior in `~/.klaude/config.yaml`:

```yaml
wrapper:
  cursor:
    startupRetries: 3          # total attempts, including the first launch
    startupRetryDelayMs: 400   # base delay before the next attempt
    startupRetryJitterMs: 200  # random jitter to stagger concurrent restarts
```

> **Tip:** Set `startupRetries: 1` to disable retries entirely.

## 🏗️ Architecture

```
User runs `klaude`
    ↓
Wrapper spawns Claude Code subprocess
    ↓
User interacts with Claude normally
    ↓
Claude spawns/manages specialized agents
```

**Inside Claude**, commands like `klaude start`, `enter-agent`, etc. communicate with the wrapper. The wrapper manages the TUI, force-interrupting it when needed and automatically starting a new TUI with the new agent spawned by Claude Code.

## 💾 State & Storage

```
~/.klaude/
  ├── sessions.db         # SQLite for session metadata + linked Claude session IDs
  ├── logs/
  │   ├── session-123.log
  │   └── session-124.log
  └── config.yaml
```

## 📋 Commands

All commands work from _within_ the Claude Code process (inside the wrapper). Many are meant to be run by Claude Code itself for multi-agent orchestration.

### Core Commands

#### `klaude`
Starts the wrapper for that directory and creates a brand new TUI Claude Code agent as the root.

```bash
klaude
```

#### `klaude start`
Spawns an agent (type loaded from agents directory) to perform the task. Agent prompt is appended with instructions on updating the parent. Runs detached by default.

```bash
klaude start <agent_type> <prompt> [agent_count] [options]
```

**Agent Type:** Name of any agent definition in your agents directory (e.g., `orchestrator`, `programmer`, `context-engineer`, or custom agents).

**Options:**
- `-c, --checkout` — Check out the agent immediately after starting
- `-s, --share` — Share current context (last X messages) with the new agent
- `-v, --verbose` — Show detailed debug information
- `--instance <id>` — Target specific wrapper instance

**Returns:** The process and session ID of the started agent.

#### `klaude checkout`
Interrupts the current agent (CLI), exits it, then enters the specified agent's session without interrupting the target agent. If no ID is provided, enters parent agent.

```bash
klaude checkout [id]
```

**Options:**
- `--timeout <seconds>` — Wait for hooks to deliver target session ID (default: 5)
- `--instance <id>` — Target specific wrapper instance

**Alias:** `enter-agent [id]`

#### `klaude message`
Sends an asynchronous message to the specified agent.

```bash
klaude message <id> <prompt> [options]
```

**Options:**
- `--timeout <seconds>` — Block until the agent responds (default: 5 seconds)
- `--instance <id>` — Target specific wrapper instance

#### `klaude interrupt`
Interrupts the specified agent's current operation.

```bash
klaude interrupt <id>
```

**Options:**
- `--signal <signal>` — Signal to send (default: SIGINT)
- `--instance <id>` — Target specific wrapper instance

#### `klaude sessions`
Views active klaude sessions, showing a brief description, first, and last message for each.

```bash
klaude sessions [options]
```

**Options:**
- `-v, --verbose` — Display more detailed information for each session

#### `klaude wait`
Block until agent session(s) complete.

```bash
klaude wait <sessionIds...> [options]
```

**Options:**
- `--timeout <seconds>` — Maximum wait time (default: no limit)
- `--any` — Return when ANY complete (vs ALL)
- `--interval <ms>` — Poll interval (default: 500ms)

#### `klaude status`
Check status of agent session(s).

```bash
klaude status <sessionIds...>
```

#### `klaude logs`
Read session logs with various filtering and streaming options.

```bash
klaude logs <id> [options]
```

**Options:**
- `-f, --follow` — Stream log continuously (like tail -f)
- `-s, --summary` — Summarize the session
- `--raw` — Show raw JSON events instead of filtered output
- `-n, --lines <N>` — Limit output to N lines (shows last N lines)
- `--tail <N>` — Show last N lines (alias for -n)
- `--head <N>` — Show first N lines
- `--instance <id>` — Target specific wrapper instance for live tailing

**Examples:**
```bash
klaude logs <id>              # View full log
klaude logs <id> --tail 50    # Show last 50 lines
klaude logs <id> -n 20        # Show last 20 lines
klaude logs <id> --head 100   # Show first 100 lines
klaude logs <id> -f           # Stream continuously
```

#### `klaude instances`
List all active wrapper instances for the current project.

```bash
klaude instances [options]
```

**Options:**
- `--status` — Query live status from active instances

#### `klaude setup-hooks`
Install Klaude hooks to `~/.claude/settings.json` for session management.

```bash
klaude setup-hooks
```

---

> **Note:** Klaude is stateful—session data persists in SQLite after you exit. You can resume or inspect previous sessions later.

## 🔌 MCP Server Configuration

Agents can be configured with specific MCP (Model Context Protocol) servers, giving them access to different tools and data sources.

MCPs are configured across three scopes with precedence: **Local > Project > User**.

### MCP Scopes

Define available MCP servers at three levels:

#### 🌍 User Scope: `~/.klaude/.mcp.json`
Klaude global MCP registry (lowest priority)

```json
{
  "mcpServers": {
    "sql": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "postgresql://localhost/mydb"
      }
    },
    "json": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-json"]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

#### 📦 Project Scope: `<project>/.mcp.json`
Shared via version control (medium priority)

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

#### 💻 Local Scope: `<project>/.claude/settings.json`
Project-specific user settings (highest priority)

```json
{
  "mcpServers": {
    "personal-dev-server": {
      "type": "stdio",
      "command": "/path/to/local/mcp-server"
    }
  }
}
```

> **Note:** Local scope MCPs are typically stored in `.claude/settings.json` which is usually gitignored, making them ideal for personal development servers, experimental configurations, or sensitive credentials specific to your machine.

### Per-Agent MCP Configuration

Agents can specify which MCPs they need in their frontmatter:

```markdown
---
name: Database Analyst
description: Analyzes SQL databases and JSON data
mcpServers: sql, json
inheritProjectMcps: false
inheritParentMcps: false
allowedAgents: junior-engineer
---

Agent instructions here...
```

#### Frontmatter Fields

| Field | Description | Default |
|-------|-------------|---------|
| `mcpServers` | Comma-separated list of MCP names from the registry (all three scopes) | - |
| `inheritProjectMcps` | Inherit all MCPs from all scopes | `true` |
| `inheritParentMcps` | Inherit parent agent's MCPs | `false` |

#### Resolution Logic

1. **If `mcpServers` is specified** → Use ONLY those MCPs (explicit override)
2. **Otherwise:**
   - If `inheritProjectMcps !== false` → Start with all available MCPs (local, project, and user scopes merged)
   - If `inheritParentMcps === true` → Add parent agent's resolved MCPs

#### Configuration Examples

**Agent with specific MCPs only:**
```yaml
mcpServers: sql, json
inheritProjectMcps: false
```

**Agent inheriting project defaults plus parent's MCPs:**
```yaml
inheritProjectMcps: true
inheritParentMcps: true
```

**Agent with project defaults but not parent's MCPs (default):**
```yaml
inheritProjectMcps: true
inheritParentMcps: false
```
