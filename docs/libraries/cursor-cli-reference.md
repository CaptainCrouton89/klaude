# Using Headless CLI

Use Cursor CLI in scripts and automation workflows for code analysis, generation, and refactoring tasks.

## How it works

Use [print mode](/docs/cli/using#non-interactive-mode) (`-p, --print`) for non-interactive scripting and automation.

### File modification in scripts

Combine `--print` with `--force` to modify files in scripts:

```
# Enable file modifications in print mode
cursor-agent -p --force "Refactor this code to use modern ES6+ syntax"

# Without --force, changes are only proposed, not applied
cursor-agent -p "Add JSDoc comments to this file"  # Won't modify files

# Batch processing with actual file changes
find src/ -name "*.js" | while read file; do
  cursor-agent -p --force "Add comprehensive JSDoc comments to $file"
done
```

The `--force` flag allows the agent to make direct file changes without
confirmation

## Setup

See [Installation](/docs/cli/installation) and [Authentication](/docs/cli/reference/authentication) for complete setup details.

```
# Install Cursor CLI
curl https://cursor.com/install -fsS | bash

# Set API key for scripts
export CURSOR_API_KEY=your_api_key_here
cursor-agent -p "Analyze this code"
```

## Example scripts

Use different output formats for different script needs. See [Output format](/docs/cli/reference/output-format) for details.

### Searching the codebase

By default, `--print` uses `text` format for clean, final-answer-only responses:

```
#!/bin/bash
# Simple codebase question - uses text format by default

cursor-agent -p "What does this codebase do?"
```

### Automated code review

Use `--output-format json` for structured analysis:

```
#!/bin/bash
# simple-code-review.sh - Basic code review script

echo "Starting code review..."

# Review recent changes
cursor-agent -p --force --output-format text \
  "Review the recent code changes and provide feedback on:
  - Code quality and readability
  - Potential bugs or issues
  - Security considerations
  - Best practices compliance

  Provide specific suggestions for improvement and write to review.txt"

if [ $? -eq 0 ]; then
  echo "✅ Code review completed successfully"
else
  echo "❌ Code review failed"
  exit 1
fi
```

### Real-time progress tracking

Use `--output-format stream-json` for message-level progress tracking, or add `--stream-partial-output` for incremental streaming of deltas:

```
#!/bin/bash
# stream-progress.sh - Track progress in real-time

echo "🚀 Starting stream processing..."

# Track progress in real-time
accumulated_text=""
tool_count=0
start_time=$(date +%s)

cursor-agent -p --force --output-format stream-json --stream-partial-output \
  "Analyze this project structure and create a summary report in analysis.txt" | \
  while IFS= read -r line; do
    
    type=$(echo "$line" | jq -r '.type // empty')
    subtype=$(echo "$line" | jq -r '.subtype // empty')
    
    case "$type" in
      "system")
        if [ "$subtype" = "init" ]; then
          model=$(echo "$line" | jq -r '.model // "unknown"')
          echo "🤖 Using model: $model"
        fi
        ;;
        
      "assistant")
        # Accumulate incremental text deltas for smooth progress
        content=$(echo "$line" | jq -r '.message.content[0].text // empty')
        accumulated_text="$accumulated_text$content"
        
        # Show live progress (updates with each character delta)
        printf "\r📝 Generating: %d chars" ${#accumulated_text}
        ;;

      "tool_call")
        if [ "$subtype" = "started" ]; then
          tool_count=$((tool_count + 1))

          # Extract tool information
          if echo "$line" | jq -e '.tool_call.writeToolCall' > /dev/null 2>&1; then
            path=$(echo "$line" | jq -r '.tool_call.writeToolCall.args.path // "unknown"')
            echo -e "\n🔧 Tool #$tool_count: Creating $path"
          elif echo "$line" | jq -e '.tool_call.readToolCall' > /dev/null 2>&1; then
            path=$(echo "$line" | jq -r '.tool_call.readToolCall.args.path // "unknown"')
            echo -e "\n📖 Tool #$tool_count: Reading $path"
          fi

        elif [ "$subtype" = "completed" ]; then
          # Extract and show tool results
          if echo "$line" | jq -e '.tool_call.writeToolCall.result.success' > /dev/null 2>&1; then
            lines=$(echo "$line" | jq -r '.tool_call.writeToolCall.result.success.linesCreated // 0')
            size=$(echo "$line" | jq -r '.tool_call.writeToolCall.result.success.fileSize // 0')
            echo "   ✅ Created $lines lines ($size bytes)"
          elif echo "$line" | jq -e '.tool_call.readToolCall.result.success' > /dev/null 2>&1; then
            lines=$(echo "$line" | jq -r '.tool_call.readToolCall.result.success.totalLines // 0')
            echo "   ✅ Read $lines lines"
          fi
        fi
        ;;

      "result")
        duration=$(echo "$line" | jq -r '.duration_ms // 0')
        end_time=$(date +%s)
        total_time=$((end_time - start_time))

        echo -e "\n\n🎯 Completed in ${duration}ms (${total_time}s total)"
        echo "📊 Final stats: $tool_count tools, ${#accumulated_text} chars generated"
        ;;
    esac
  done
```


# Parameters

## Global options

Global options can be used with any command:

OptionDescription`-v, --version`Output the version number`-a, --api-key <key>`API key for authentication (can also use `CURSOR_API_KEY` env var)`-p, --print`Print responses to console (for scripts or non-interactive use). Has access to all tools, including write and bash.`--output-format <format>`Output format (only works with `--print`): `text`, `json`, or `stream-json` (default: `text`)`--stream-partial-output`Stream partial output as individual text deltas (only works with `--print` and `stream-json` format)`-b, --background`Start in background mode (open composer picker on launch)`--fullscreen`Enable fullscreen mode`--resume [chatId]`Resume a chat session`-m, --model <model>`Model to use`-f, --force`Force allow commands unless explicitly denied`-h, --help`Display help for command
## Commands

CommandDescriptionUsage`login`Authenticate with Cursor`cursor-agent login``logout`Sign out and clear stored authentication`cursor-agent logout``status`Check authentication status`cursor-agent status``mcp`Manage MCP servers`cursor-agent mcp``update|upgrade`Update Cursor Agent to the latest version`cursor-agent update` or `cursor-agent upgrade``ls`Resume a chat session`cursor-agent ls``resume`Resume the latest chat session`cursor-agent resume``help [command]`Display help for command`cursor-agent help [command]`
When no command is specified, Cursor Agent starts in interactive chat mode by
default.

## MCP

Manage MCP servers configured for Cursor Agent.

SubcommandDescriptionUsage`login <identifier>`Authenticate with an MCP server configured in `.cursor/mcp.json``cursor-agent mcp login <identifier>``list`List configured MCP servers and their status`cursor-agent mcp list``list-tools <identifier>`List available tools and their argument names for a specific MCP`cursor-agent mcp list-tools <identifier>`
All MCP commands support `-h, --help` for command-specific help.

## Arguments

When starting in chat mode (default behavior), you can provide an initial prompt:

**Arguments:**

- `prompt` — Initial prompt for the agent

## Getting help

All commands support the global `-h, --help` option to display command-specific help.

# Authentication

Cursor CLI supports two authentication methods: browser-based login (recommended) and API keys.

## Browser authentication (recommended)

Use the browser flow for the easiest authentication experience:

```
# Log in using browser flow
cursor-agent login

# Check authentication status
cursor-agent status

# Log out and clear stored authentication
cursor-agent logout
```

The login command will open your default browser and prompt you to authenticate with your Cursor account. Once completed, your credentials are securely stored locally.

## API key authentication

For automation, scripts, or CI/CD environments, use API key authentication:

### Step 1: Generate an API key

Generate an API key in your Cursor dashboard under Integrations > User API Keys.

### Step 2: Set the API key

You can provide the API key in two ways:

**Option 1: Environment variable (recommended)**

```
export CURSOR_API_KEY=your_api_key_here
cursor-agent "implement user authentication"
```

**Option 2: Command line flag**

```
cursor-agent --api-key your_api_key_here "implement user authentication"
```

## Authentication status

Check your current authentication status:

```
cursor-agent status
```

This command will display:

- Whether you're authenticated
- Your account information
- Current endpoint configuration

## Troubleshooting

- **"Not authenticated" errors:** Run `cursor-agent login` or ensure your API key is correctly set
- **SSL certificate errors:** Use the `--insecure` flag for development environments
- **Endpoint issues:** Use the `--endpoint` flag to specify a custom API endpoint


# Configuration

Configure the Agent CLI using the `cli-config.json` file.

## File location

TypePlatformPathGlobalmacOS/Linux`~/.cursor/cli-config.json`GlobalWindows`$env:USERPROFILE\.cursor\cli-config.json`ProjectAll`<project>/.cursor/cli.json`
Only permissions can be configured at the project level. All other CLI
settings must be set globally.

Override with environment variables:

- **`CURSOR_CONFIG_DIR`**: custom directory path
- **`XDG_CONFIG_HOME`** (Linux/BSD): uses `$XDG_CONFIG_HOME/cursor/cli-config.json`

## Schema

### Required fields

FieldTypeDescription`version`numberConfig schema version (current: `1`)`editor.vimMode`booleanEnable Vim keybindings (default: `false`)`permissions.allow`string[]Permitted operations (see [Permissions](/docs/cli/reference/permissions))`permissions.deny`string[]Forbidden operations (see [Permissions](/docs/cli/reference/permissions))
### Optional fields

FieldTypeDescription`model`objectSelected model configuration`hasChangedDefaultModel`booleanCLI-managed model override flag
## Examples

### Minimal config

```
{
  "version": 1,
  "editor": { "vimMode": false },
  "permissions": { "allow": ["Shell(ls)"], "deny": [] }
}
```

### Enable Vim mode

```
{
  "version": 1,
  "editor": { "vimMode": true },
  "permissions": { "allow": ["Shell(ls)"], "deny": [] }
}
```

### Configure permissions

```
{
  "version": 1,
  "editor": { "vimMode": false },
  "permissions": {
    "allow": ["Shell(ls)", "Shell(echo)"],
    "deny": ["Shell(rm)"]
  }
}
```

See [Permissions](/docs/cli/reference/permissions) for available permission types and examples.

## Troubleshooting

**Config errors**: Move the file aside and restart:

```
mv ~/.cursor/cli-config.json ~/.cursor/cli-config.json.bad
```

**Changes don't persist**: Ensure valid JSON and write permissions. Some fields are CLI-managed and may be overwritten.

## Notes

- Pure JSON format (no comments)
- CLI performs self-repair for missing fields
- Corrupted files are backed up as `.bad` and recreated
- Permission entries are exact strings (see [Permissions](/docs/cli/reference/permissions) for details)

## Models

You can select a model for the CLI using the `/model` slash command.

```
/model auto
/model gpt-5
/model sonnet-4
```

See the [Slash commands](/docs/cli/reference/slash-commands) docs for other commands.