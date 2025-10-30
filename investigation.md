# Investigation: Modifying Agent Creation to Use `output_style` Parameter

## Executive Summary

Currently, agent markdown files contain YAML frontmatter followed by content. The content after the frontmatter (agent instructions) is being concatenated with the user prompt and passed as a single `prompt` parameter to the Claude Agent SDK. This investigation documents the current flow and identifies all locations that need modification to pass agent instructions as `output_style` instead.

**Key Finding**: `output_style` appears in `SDKSystemMessage` (a message type returned by the SDK) but is not currently documented as an input option in the `Options` type. This may indicate:
1. It's a newer feature not yet documented
2. It's passed via `extraArgs` or another mechanism
3. The SDK needs to be updated to support it

## Current Implementation Flow

### 1. Agent Definition Parsing

**Location**: `src/services/agent-definitions.ts`

- **Function**: `parseAgentFile()` (lines 144-230)
  - Parses YAML frontmatter delimited by `---`
  - Extracts metadata (name, description, model, etc.)
  - Extracts `instructions` from content after frontmatter (line 210)
  - Returns `AgentDefinition` object with `instructions` field

- **Function**: `composeAgentPrompt()` (lines 232-242)
  - **Current behavior**: Combines agent definition components into a single prompt string
  - Concatenates: `description` + `instructions` + `userPrompt` (joined with `\n\n`)
  - **Issue**: This mixing of agent instructions with user prompt prevents using `output_style`

### 2. Agent Session Creation

**Location**: `src/services/wrapper-instance.ts`

- **Function**: `handleStartAgent()` (lines 404-668)
  - Line 637-639: Calls `composeAgentPrompt(agentDefinition, payload.prompt)`
  - Line 645: Passes composed prompt to `startAgentRuntimeProcess()`
  - The composed prompt combines agent instructions with user prompt

- **Function**: `startAgentRuntimeProcess()` (lines 808-999)
  - Line 961: Creates `RuntimeInitPayload` with `prompt: payload.prompt` (the composed prompt)
  - Line 986: Sends payload to agent runtime process via stdin

### 3. Agent Runtime Execution

**Location**: `src/runtime/agent-runtime.ts`

- **Interface**: `RuntimeInitPayload` (lines 26-58)
  - Currently only has `prompt: string` field
  - No field for `output_style` or separate instructions

- **Function**: `run()` (lines 278-424)
  - Line 314: Passes `init.prompt` directly to SDK `query()` function
  - Line 282: Validates prompt is non-empty (will need adjustment)

- **Function**: `listenForMessages()` (lines 357-403)
  - Line 382: Subsequent messages also use `prompt` parameter
  - These messages should NOT include agent instructions (only user prompt)

### 4. SDK Query Invocation

**Location**: `src/runtime/agent-runtime.ts`

- **Function**: `query()` call (line 313-316)
  ```typescript
  stream = query({
    prompt: init.prompt,  // Currently contains instructions + user prompt
    options,
  });
  ```

- **Options structure**: Built in `buildQueryOptions()` (lines 203-276)
  - No `output_style` option currently set
  - Would need to add `output_style` to options if SDK supports it

## What `output_style` Does (According to SDK Docs)

### From `docs/libraries/typescript-sdk.md`

**Observation**: `output_style` appears in `SDKSystemMessage` type (line 467):
```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  // ...
  output_style: string;  // Present in system message
}
```

**Issue**: `output_style` is NOT listed in the `Options` type (lines 84-117), which includes:
- `systemPrompt`
- `model`
- `mcpServers`
- etc.

**Implications**:
1. `output_style` may be a newer SDK feature not yet documented
2. It might be passed via `extraArgs: Record<string, string | null>` (line 101)
3. It might be part of `systemPrompt` configuration
4. The SDK may need to be updated to support it as a top-level option

**Assumption for investigation**: We'll proceed assuming `output_style` should be passed as a top-level option in `QueryOptions`, similar to `systemPrompt`. If not supported, it may need to be passed via `extraArgs` or `systemPrompt.append`.

## Required Code Changes

### 1. Agent Definition Interface

**File**: `src/services/agent-definitions.ts`

**Change**: Keep `instructions` field separate (already exists)
- No changes needed to parsing logic
- `instructions` field already extracted correctly (line 220)

**Consideration**: May want to rename `instructions` to `outputStyle` for clarity, but this is optional.

### 2. Remove Prompt Composition

**File**: `src/services/agent-definitions.ts`

**Change**: Modify or deprecate `composeAgentPrompt()`
- **Option A**: Remove function entirely
- **Option B**: Keep for backward compatibility but don't use for agent instructions
- **Recommendation**: Deprecate and update callers to pass instructions separately

### 3. Update Wrapper Instance Payload

**File**: `src/services/wrapper-instance.ts`

**Changes**:
- **Line 637-639**: Stop calling `composeAgentPrompt()` for instructions
- **Line 961**: Pass both `prompt` (user prompt only) and `outputStyle` (agent instructions) separately in `RuntimeInitPayload`
- Consider: Should `description` still be prepended to user prompt, or also moved to `output_style`?

**Decision needed**: How to handle `description` field?
- **Option A**: Keep description in prompt (brief agent description)
- **Option B**: Move description to `output_style` with instructions
- **Recommendation**: Option A - description provides context, instructions define behavior/style

### 4. Update Runtime Payload Interface

**File**: `src/runtime/agent-runtime.ts`

**Changes**:
- **Line 26-58**: Add `outputStyle?: string | null` to `RuntimeInitPayload` interface
- **Line 281-283**: Update validation - require either `prompt` OR `outputStyle` (or both)
- **Line 314**: Pass `output_style` to SDK options if provided

### 5. Update SDK Query Options

**File**: `src/runtime/agent-runtime.ts`

**Changes**:
- **Function**: `buildQueryOptions()` (lines 203-276)
  - Add `output_style` to options if present in `init.outputStyle`
  - **Uncertainty**: Verify SDK supports `output_style` as option, or use `extraArgs`

**Example change**:
```typescript
if (init.outputStyle) {
  options.output_style = init.outputStyle;  // If SDK supports directly
  // OR
  options.extraArgs = { ...options.extraArgs, output_style: init.outputStyle };
}
```

### 6. Handle Subsequent Messages

**File**: `src/runtime/agent-runtime.ts`

**Function**: `listenForMessages()` (lines 357-403)

**Issue**: Subsequent messages via `klaude message` should NOT include agent instructions
- **Current**: Line 382 passes user prompt only (correct)
- **No change needed**: Messages already use user prompt only

**Verification**: Ensure `handleMessage()` in `wrapper-instance.ts` doesn't add instructions
- **Check**: `src/services/wrapper-instance.ts` line 1864 - passes `payload.prompt` directly (correct)

## Edge Cases and Considerations

### 1. Backward Compatibility

**Issue**: Existing agent definitions may rely on current behavior
- **Solution**: Support both modes during transition
- **Approach**: If `outputStyle` provided, use it; otherwise fall back to prompt composition

### 2. Empty Instructions

**Issue**: What if agent has no content after frontmatter?
- **Current**: `instructions` would be `null` (line 210)
- **Behavior**: Skip `output_style` if instructions are empty/null
- **Validation**: Don't require `output_style` if not provided

### 3. Description Field Handling

**Question**: Should `description` be included in `output_style` or remain in prompt?
- **Current**: Description is part of composed prompt
- **Recommendation**: Keep description separate (brief agent intro), instructions go to `output_style`
- **Alternative**: Description + instructions together in `output_style`

### 4. SDK Compatibility

**Risk**: SDK may not support `output_style` parameter yet
- **Mitigation**: 
  1. Check SDK version/type definitions
  2. Fallback to `extraArgs` if direct option not available
  3. Test with actual SDK version in use

### 5. Multiple Query Locations

**Locations using `query()`**:
1. Initial query (line 314) - needs `output_style`
2. Subsequent messages (line 382) - should NOT use `output_style` (session already has it)

**Consideration**: Does `output_style` persist across resumed sessions?
- **Assumption**: `output_style` is set once per session, persists with `resume`
- **Verification needed**: Check SDK behavior with `resume` + `output_style`

### 6. Agent Definition Scope

**Current**: Agents can be project-scoped (`.claude/agents/`) or user-scoped (`~/.claude/agents/`)
- **Impact**: None - parsing logic already handles both
- **No changes needed**: Parsing extracts instructions regardless of scope

### 7. Message Command

**File**: `src/commands/message.ts` and `src/services/wrapper-instance.ts`

**Verification**: Messages sent via `klaude message <id> <prompt>` should not include agent instructions
- **Current**: Line 1864 in `wrapper-instance.ts` passes user prompt only (correct)
- **No changes needed**: Messages already correct

### 8. Type Safety

**Consideration**: Update TypeScript types for `QueryOptions`
- **Issue**: Type definitions may not include `output_style`
- **Solution**: 
  1. Check `@anthropic-ai/claude-agent-sdk` type definitions
  2. Use type assertion if needed: `options as QueryOptions & { output_style?: string }`
  3. Or extend types locally

## Testing Strategy

### Unit Tests Needed

1. **Agent Definition Parsing**
   - Test extraction of instructions separate from prompt
   - Test empty instructions handling
   - Test description vs instructions separation

2. **Prompt Composition**
   - Test that instructions are NOT included in prompt when `output_style` used
   - Test backward compatibility mode

3. **Runtime Payload**
   - Test `RuntimeInitPayload` with `outputStyle` field
   - Test validation logic

4. **SDK Integration**
   - Test `output_style` passed correctly to SDK
   - Test fallback behavior if SDK doesn't support it

### Integration Tests Needed

1. **End-to-End Agent Start**
   - Start agent with instructions in markdown
   - Verify `output_style` set correctly
   - Verify user prompt separate from instructions

2. **Message Handling**
   - Send message to running agent
   - Verify message doesn't include instructions
   - Verify agent still follows original instructions

3. **Session Resume**
   - Checkout agent session
   - Verify `output_style` persists across resume

## Migration Path

### Phase 1: Add Support (Backward Compatible)
1. Add `outputStyle` to `RuntimeInitPayload`
2. Extract instructions separately in wrapper
3. Pass to runtime but don't use yet
4. Keep prompt composition as fallback

### Phase 2: Switch to `output_style`
1. Update SDK query to use `output_style` when available
2. Update prompt composition to exclude instructions
3. Test thoroughly

### Phase 3: Cleanup
1. Remove prompt composition for instructions
2. Update documentation
3. Deprecate old behavior

## Files Requiring Changes

### Core Changes
1. `src/services/agent-definitions.ts` - Stop composing instructions into prompt
2. `src/services/wrapper-instance.ts` - Pass instructions separately
3. `src/runtime/agent-runtime.ts` - Accept and use `output_style` parameter

### Type Updates
1. `src/runtime/agent-runtime.ts` - Update `RuntimeInitPayload` interface
2. Potentially extend SDK `QueryOptions` type if not in SDK

### Tests
1. Add tests for new behavior
2. Update existing tests that rely on prompt composition

## Open Questions

1. **SDK Support**: Does the SDK actually support `output_style` as an option? Or is it read-only from system messages?
2. **Description Placement**: Should `description` go to `output_style` or stay in prompt?
3. **Backward Compatibility**: How long should we support prompt composition mode?
4. **Validation**: Should we require `output_style` for all agents, or make it optional?

## Summary

The change requires modifications across three main files:
- **agent-definitions.ts**: Extract but don't compose instructions
- **wrapper-instance.ts**: Pass instructions separately to runtime
- **agent-runtime.ts**: Accept `outputStyle` and pass as `output_style` to SDK

The main uncertainty is whether the SDK supports `output_style` as an input option. If not, it may need to be passed via `extraArgs` or the SDK may need updating.
