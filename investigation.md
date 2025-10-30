# Investigation: MCP Scope Hierarchy Implementation

## Summary

The klaude project currently implements **2 out of 3 MCP scopes** from Claude Code's design:
- ✅ **Project scope**: `.mcp.json` in project root (shared, version-controlled)
- ✅ **User scope**: `~/.klaude/.mcp.json` (global user registry)
- ❌ **Local scope**: `.claude/settings.json` (project-specific user settings) — **MISSING**

**Precedence order (expected)**: Local > Project > User
**Precedence order (actual)**: Project > User (local scope not implemented)

## Current Implementation Analysis

### 1. MCP Loader (`src/services/mcp-loader.ts`)

**Lines 24-49: `loadProjectMcps(projectRoot)`**
- Loads from `<projectRoot>/.mcp.json`
- Returns empty object if not found
- ✅ Correctly implements project scope

**Lines 55-81: `loadKlaudeMcps()`**
- Loads from `~/.klaude/.mcp.json`
- Returns empty object if not found
- ✅ Correctly implements user scope (renamed from "global" to align with Claude Code terminology)

**Lines 87-98: `loadAvailableMcps(projectRoot)`**
```typescript
export async function loadAvailableMcps(projectRoot: string): Promise<Record<string, McpServerConfig>> {
  const [klaudeMcps, projectMcps] = await Promise.all([
    loadKlaudeMcps(),        // User scope: ~/.klaude/.mcp.json
    loadProjectMcps(projectRoot),  // Project scope: <project>/.mcp.json
  ]);

  // Project MCPs override klaude global MCPs for same names
  return {
    ...klaudeMcps,    // User scope (lowest priority)
    ...projectMcps,   // Project scope (higher priority)
  };
}
```

**Issue**: Missing local scope loader for `.claude/settings.json` MCPs

### 2. MCP Resolver (`src/services/mcp-resolver.ts`)

**Lines 40-71: `resolveMcpServers(context)`**
- Accepts `availableMcps` as input (all merged MCPs)
- Does NOT perform scope hierarchy resolution itself
- Relies on `mcp-loader.ts` to provide correctly merged MCPs
- ✅ Logic is correct for agent-level inheritance

**Resolution logic**:
1. If agent defines `mcpServers` → Use ONLY those (explicit override)
2. Otherwise:
   - If `inheritProjectMcps !== false` → Include all available MCPs
   - If `inheritParentMcps === true` → Add parent's resolved MCPs

**Issue**: Works correctly, but receives incomplete `availableMcps` without local scope

### 3. Wrapper Instance (`src/services/wrapper-instance.ts`)

**Lines 514-517: Agent start handler**
```typescript
const { loadAvailableMcps } = await import('./mcp-loader.js');
const availableMcps = await loadAvailableMcps(context.projectRoot);
```

**Lines 941-942: Agent runtime init**
```typescript
const { loadAvailableMcps } = await import('./mcp-loader.js');
const availableMcps = await loadAvailableMcps(context.projectRoot);
```

**Issue**: Calls `loadAvailableMcps()` which only returns project + user scopes

## Gap Analysis

### Missing Implementation: Local Scope

**Expected behavior** (per Claude Code docs):
- Local-scoped MCPs stored in `.claude/settings.json` (project-specific user settings)
- Precedence: Local > Project > User
- "Personal development servers, experimental configurations, or servers containing sensitive credentials"

**What needs to be added**:

1. **New loader function**: `loadLocalMcps(projectRoot)` in `mcp-loader.ts`
   - Read from `<projectRoot>/.claude/settings.json`
   - Parse `mcpServers` field from settings
   - Return empty object if file missing or no mcpServers

2. **Update `loadAvailableMcps()`** to include local scope:
   ```typescript
   const [userMcps, projectMcps, localMcps] = await Promise.all([
     loadKlaudeMcps(),           // ~/.klaude/.mcp.json
     loadProjectMcps(projectRoot), // <project>/.mcp.json
     loadLocalMcps(projectRoot),   // <project>/.claude/settings.json
   ]);

   return {
     ...userMcps,    // Lowest priority
     ...projectMcps, // Medium priority
     ...localMcps,   // Highest priority (overrides others)
   };
   ```

3. **Documentation updates**:
   - Update `README.md` to document `.claude/settings.json` format
   - Update comments in `mcp-loader.ts` to reflect 3 scopes

## Related Files

### Configuration Structure

**`~/.claude/settings.json`** (user-global settings):
```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "...",
      "args": []
    }
  }
}
```

**`.claude/settings.json`** (project-local settings):
```json
{
  "mcpServers": {
    "local-server": {
      "type": "stdio",
      "command": "...",
      "args": []
    }
  }
}
```

**Current implementation only checks**:
- `~/.klaude/.mcp.json` (user scope)
- `<project>/.mcp.json` (project scope)

**Missing**:
- `.claude/settings.json` (local scope)

## Verification

### Test Cases to Validate Fix

1. **User-scoped MCP**: Define server in `~/.klaude/.mcp.json`
2. **Project-scoped MCP**: Define same server in `<project>/.mcp.json`
3. **Local-scoped MCP**: Define same server in `<project>/.claude/settings.json`
4. **Expected result**: Local scope server used (highest precedence)

### Code Locations

| File | Line | Purpose |
|------|------|---------|
| `src/services/mcp-loader.ts` | 87-98 | `loadAvailableMcps()` - needs local scope loader |
| `src/services/mcp-loader.ts` | 24-49 | `loadProjectMcps()` - reference pattern for local loader |
| `src/services/mcp-resolver.ts` | 40-71 | `resolveMcpServers()` - correct, no changes needed |
| `src/services/wrapper-instance.ts` | 514-517, 941-942 | Calls `loadAvailableMcps()` - no changes needed |
| `README.md` | 155-220 | MCP documentation - needs update to include local scope |

## Recommendations

### Priority 1: Implement Local Scope

1. Add `loadLocalMcps(projectRoot)` function to `mcp-loader.ts`
2. Update `loadAvailableMcps()` to merge all 3 scopes with correct precedence
3. Add tests to verify local > project > user hierarchy

### Priority 2: Documentation

1. Update `README.md` MCP section to document `.claude/settings.json`
2. Update `mcp-loader.ts` comments to reflect 3 scopes
3. Add example `.claude/settings.json` to docs

### Priority 3: Validation

1. Add integration test for 3-way scope precedence
2. Verify agent MCP inheritance works across all 3 scopes
3. Test parent MCP inheritance with mixed scopes

## References

- **MCP Reference**: `/Users/silasrhyneer/Code/claude-tools/klaude/docs/libraries/mcp-reference.md:801-855`
- **Claude Code Docs**: Local scope stored in "project-specific user settings" (`.claude/settings.json`)
- **Current Implementation**: Only loads from 2 sources (user + project)
- **Git Commit**: `5b8d897c` migrated MCPs from `config.yaml` to `.mcp.json` (user scope only)
