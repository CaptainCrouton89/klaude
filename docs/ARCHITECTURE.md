# Klaude Architecture & Implementation Notes

This document explains the complex session-switching mechanism used in klaude, which will need to be re-implemented when moving from bash scripts to TypeScript.

## Session Switching Mechanism

The core challenge: How do you seamlessly switch Claude Code contexts without losing state?

**Solution**: Wrapper loop + marker files + process signals

### High-Level Flow

```
User runs: klaude
  ↓
Wrapper spawns Claude as subprocess
  ↓
User interacts with Claude normally
  ↓
User calls: enter-agent <agent-id>
  ↓
enter-agent writes marker file + kills Claude process
  ↓
Wrapper detects process death + marker file
  ↓
Wrapper spawns Claude again with --resume <session-id>
  ↓
User is now in different agent's session (full history preserved)
```

## Bash Implementation Details

### 1. claude-wrapper (`demo/claude-wrapper`)

**Purpose**: Main loop that spawns/re-spawns Claude Code processes

**Key mechanism**:
```bash
while true; do
  /opt/homebrew/bin/claude "$@"      # Run Claude in foreground
  CLAUDE_EXIT=$?

  if [ -f "$NEXT_SESSION_FILE" ]; then
    NEXT_SESSION=$(cat "$NEXT_SESSION_FILE")
    rm -f "$NEXT_SESSION_FILE"        # Clean up marker
    set -- --resume "$NEXT_SESSION"   # Update args for next run
    continue                          # Loop again with new args
  fi

  break                               # No marker, exit wrapper
done
```

**Critical points**:
- Claude runs in **foreground** (not backgrounded), so wrapper can wait for exit code
- **Not using `exec`** — this keeps wrapper alive after Claude exits
- Watches for `.next-session` marker file written by `enter-agent`
- If marker exists, extracts session ID and re-spawns Claude with `--resume`
- If no marker, assumes normal exit and breaks loop

**State files maintained**:
- `.wrapper-pid`: Wrapper's own process ID (for enter-agent to signal)
- `.next-session`: Session ID to resume (written by enter-agent)
- Logging to `/tmp/claude-wrapper.log` for debugging

### 2. enter-agent (`demo/enter-agent`)

**Purpose**: Triggered from within Claude to switch to a different agent session

**Key mechanism**:
```bash
# 1. Look up target session info from registry
SESSION_ID=$(jq -r ".\"$AGENT_ID\".sessionId" "$REGISTRY")
PARENT_SESSION=$(jq -r ".\"$AGENT_ID\".parentSessionId" "$REGISTRY")
PARENT_PID=$(jq -r ".\"$AGENT_ID\".parentPid" "$REGISTRY")

# 2. Write marker file for wrapper to detect
echo "$SESSION_ID" > "$NEXT_SESSION_FILE"

# 3. Write current agent ID (for exit-agent to track)
echo "$AGENT_ID" > "$CURRENT_AGENT_FILE"

# 4. Kill parent Claude process (signals wrapper to check for marker)
kill "$PARENT_PID"

# 5. Exit (Claude process dies, wrapper wakes up and sees marker)
exit 0
```

**Critical points**:
- Polls for `.active-pids.json` registry to exist (agent may not be captured yet)
- Retrieves parent PID from registry (PID of Claude process that's running)
- **Writes marker BEFORE killing** — so wrapper sees marker when it wakes up
- Uses `kill $PID` to deliver SIGTERM (not SIGKILL), allowing graceful shutdown
- Adds small delay (`sleep 0.2`) before kill to ensure file is written
- Returns exit code 0 (success) so Claude sees clean exit

### 3. Registry File (`.active-pids.json`)

**Structure**:
```json
{
  "agent-001": {
    "sessionId": "abc123",
    "agentType": "orchestrator",
    "parentSessionId": "parent-id",
    "parentPid": 12345,
    "startedAt": 1234567890
  },
  "agent-002": {
    "sessionId": "def456",
    ...
  }
}
```

**Purpose**:
- Maps agent IDs → session info + parent PID
- Populated when `klaude start` is called from within Claude
- Enables `enter-agent` to find the right process to kill
- Allows agents to know their parent session (for return context)

**When populated**:
- `klaude start <type> <prompt>` creates an entry
- entry includes the PID of the Claude process that called it (parent)
- Allows later `enter-agent` calls to signal the right process

## Implementation Requirements for TypeScript

When re-implementing this in TypeScript, you'll need:

### 1. Wrapper Loop (replaces claude-wrapper)
```typescript
// Main klaude entry point with no args
// Launches TypeScript wrapper that:
// - Spawns: child_process.spawn('claude', args, { stdio: 'inherit' })
// - Waits: child.on('exit', ...)
// - Detects: fs.existsSync('.next-session') after exit
// - Re-runs: if marker exists, read session ID and respawn
```

### 2. Registry Manager
```typescript
// Reads/writes ~/.klaude/.active-pids.json
// Methods:
// - register(agentId, sessionId, parentSessionId, parentPid)
// - lookup(agentId) → {sessionId, parentSessionId, parentPid}
// - unregister(agentId)
// - listActive() → all registered agents
```

### 3. Session Switch Commands
```typescript
// Within Claude, expose these commands:
// - klaude start <type> <prompt>      → spawns agent subprocess
// - klaude sessions                   → lists all sessions (from DB)
// - enter-agent <agent-id>            → triggers switch
//   a) Looks up agent in registry
//   b) Writes .next-session marker
//   c) Kills parent Claude process (process.kill(ppid, 'SIGTERM'))
//   d) Exits
```

### 4. Critical Implementation Details

**File operations**:
- Must be synchronous when writing markers (enter-agent needs guarantee)
- Use `fs.writeFileSync()` for marker files
- Use `fs.existsSync()` to check for marker after child exit

**Process management**:
- `child_process.spawn()` not `exec()` — need `stdio: 'inherit'` for terminal
- Monitor `exit` event, not `close` event (exit fires first)
- Use `child.kill('SIGTERM')` from enter-agent, not SIGKILL
- Parent process should wait for kill to complete

**Timing**:
- Small delay after writing marker before kill (sync guarantees)
- Retry loop when reading registry (parent PID may not be captured yet)
- Cleanup stale marker files at wrapper startup

**Debugging**:
- Log wrapper activity to temp file (like `/tmp/klaude-wrapper.log`)
- Support `KLAUDE_DEBUG` env var for debug logging
- Write process IDs and timestamps for troubleshooting

## Edge Cases to Handle

1. **Agent not in registry yet**
   - `enter-agent` polls with retry loop (20 retries × 0.5s = 10s timeout)
   - Handles race condition where agent ID is passed but registry not updated

2. **Parent process already dead**
   - `kill()` on dead PID should be caught gracefully
   - Use `process.kill(pid)` and catch ESRCH error

3. **Stale marker files**
   - Wrapper should `rm -f` marker at startup
   - Prevents old markers from triggering unwanted switches

4. **Read-only sessions**
   - If agent already completed, should warn user
   - Still allow resuming but indicate it's read-only

5. **Nested wrappers**
   - If user calls `klaude` from within a klaude session, it should work
   - May need to track wrapper PIDs in registry

## Testing Strategy

When re-implementing, test these scenarios:

```bash
# 1. Basic spawn
klaude start programmer "hello"
# Verify: Claude opens, process tracked in registry

# 2. Simple session switch
(inside Claude) enter-agent <agent-id>
# Verify: Wrapper detects kill, reads marker, respawns

# 3. Multiple concurrent agents
klaude start programmer "task1"
# (inside) klaude start planner "task2"
# (inside) enter-agent <agent-1>
# (inside) enter-agent <agent-2>
# Verify: Can switch between multiple parallel agents

# 4. Registry cleanup
# Verify: Stale entries removed after agent completes
```

## Open Questions

1. How should subprocess stdio be handled? Currently inherited to terminal.
   - Should there be logging to files?
   - Should there be output capture for the registry?

2. Should the wrapper support multiple concurrent Claude sessions?
   - Current model: one Claude session at a time
   - Future: could track multiple parent PIDs, allow user to manage queues?

3. How should the TypeScript wrapper handle TypeScript errors?
   - Should it log and continue?
   - Should it exit and clean up gracefully?

4. Should `klaude` support additional flags like `--debug`, `--no-wrapper`, etc.?
