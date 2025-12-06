#!/usr/bin/env node

/**
 * Agent runtime entry point. Reads configuration from stdin, invokes Claude Code
 * via the local CLI SDK, and streams structured events back to the wrapper over stdout.
 */

import { exit, stderr, stdin, stdout } from 'node:process';
import readline from 'node:readline';

import type {
  HookInput,
  HookJSONOutput,
  Query,
  Options as QueryOptions,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@r-cli/sdk'; // fork of the sdk that uses your own auth token
import type { McpServerConfig } from '../types/index.js';

type PermissionMode = QueryOptions['permissionMode'];

interface RuntimeInitPayload {
  sessionId: string;
  agentType: string;
  prompt: string;
  /**
   * Agent instructions to be appended to the system prompt via systemPrompt.append
   */
  outputStyle?: string | null;
  options?: {
    checkout?: boolean;
    share?: boolean;
    detach?: boolean;
  };
  // If provided, resume this Claude session id when running the initial query
  resumeClaudeSessionId?: string | null;
  metadata?: {
    projectHash?: string;
    projectRoot?: string;
    instanceId?: string;
    parentSessionId?: string | null;
    agentCount?: number | null;
  };
  sdk?: {
    model?: string | null;
    fallbackModel?: string | null;
    permissionMode?: PermissionMode | null;
    pathToClaudeCodeExecutable?: string | null;
    reasoningEffort?: 'low' | 'medium' | 'high' | null;
  };
  /**
   * All available MCP servers from registries (.mcp.json, config.yaml)
   */
  availableMcps?: Record<string, McpServerConfig>;
  /**
   * Parent agent's resolved MCP servers (for inheritance)
   */
  parentMcps?: Record<string, McpServerConfig>;
}

type OutboundEvent =
  | { type: 'status'; status: 'starting' | 'running' | 'completed'; detail?: string }
  | { type: 'message'; messageType: string; payload: unknown; text?: string | null }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result?: unknown; stopReason?: string | null }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'claude-session'; sessionId: string; transcriptPath?: string | null }
  | { type: 'done'; status: 'done' | 'failed' | 'interrupted'; reason?: string };

function emit(event: OutboundEvent): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

async function readRuntimeConfig(): Promise<RuntimeInitPayload> {
  if (stdin.isTTY) {
    throw new Error('Runtime config must be provided on stdin');
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stdin });

    rl.once('line', (line) => {
      rl.close();
      const raw = line.trim();
      if (!raw) {
        reject(new Error('Runtime config payload is empty'));
        return;
      }

      try {
        resolve(JSON.parse(raw) as RuntimeInitPayload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`Unable to parse runtime config JSON: ${message}`));
      }
    });

    rl.once('error', (error) => {
      reject(error);
    });
  });
}


function extractAssistantText(message: SDKAssistantMessage): string | null {
  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (item && typeof item === 'object' && 'text' in item) {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }

  return parts.length > 0 ? parts.join('') : null;
}

function extractPartialText(message: SDKPartialAssistantMessage): string | null {
  const event = message.event as { delta?: unknown; type?: string };
  if (event?.type === 'message_delta' && event.delta && typeof event.delta === 'object') {
    const delta = event.delta as { text?: string };
    if (typeof delta.text === 'string') {
      return delta.text;
    }
  }
  return null;
}

function extractResultText(message: SDKResultMessage): string | null {
  if ('result' in message && typeof message.result === 'string') {
    return message.result;
  }
  return null;
}

function extractMessageText(message: SDKMessage): string | null {
  switch (message.type) {
    case 'assistant':
      return extractAssistantText(message);
    case 'stream_event':
      return extractPartialText(message);
    case 'result':
      return extractResultText(message);
    default:
      return null;
  }
}

/**
 * Hook callback that blocks the Task tool and redirects to klaude commands
 */
async function blockTaskToolHook(
  input: HookInput,
  _toolUseID: string | undefined,
  _options: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') {
    return {};
  }

  // Block Task tool usage
  if (input.tool_name === 'Task') {
    // Extract parameters to provide specific command example
    const toolInput = input.tool_input as { subagent_type?: string; prompt?: string } | undefined;

    if (!toolInput || !toolInput.subagent_type || !toolInput.prompt) {
      throw new Error(
        `Task tool input is required: subagent_type and prompt are required. Passed input: ${JSON.stringify(input)}`
      );
    }

    const agentType = toolInput.subagent_type;

    // Allow Plan and Explore agents to use native Task tool
    const TASK_TOOL_EXEMPT_AGENTS = ['Plan', 'Explore'];
    if (TASK_TOOL_EXEMPT_AGENTS.includes(agentType)) {
      return {}; // Allow through (empty response = allowed)
    }

    const promptPreview = toolInput.prompt.slice(0, 10);

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `The Task tool is replaced with \`klaude start ${agentType} "${promptPreview}..."\`. You MUST re-delegate this task, but use klaude instead. Treat this just like you would the Task tool, but use the klaude cli instead.

To start a task, use:
  klaude start ${agentType} "${promptPreview}..."`,
      },
    };
  }

  return {};
}

async function buildQueryOptions(
  init: RuntimeInitPayload,
  abortController: AbortController,
): Promise<QueryOptions> {
  // Klaude agents run in bypassPermissions mode by default
  const permissionMode: PermissionMode = init.sdk?.permissionMode ? init.sdk.permissionMode : 'bypassPermissions';

  const options: QueryOptions = {
    abortController,
    includePartialMessages: true,
    permissionMode,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Task',
          hooks: [blockTaskToolHook],
        },
      ],
    },
  };

  // Add optional model settings if provided
  if (init.sdk?.model) {
    options.model = init.sdk.model;
  }
  if (init.sdk?.fallbackModel) {
    options.fallbackModel = init.sdk.fallbackModel;
  }
  if (init.sdk?.pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = init.sdk.pathToClaudeCodeExecutable;
  }
  if (init.sdk?.reasoningEffort) {
    (options as QueryOptions & { reasoningEffort?: string }).reasoningEffort = init.sdk.reasoningEffort;
  }

  // Continue a specific Claude session if requested
  if (typeof init.resumeClaudeSessionId === 'string' && init.resumeClaudeSessionId.trim().length > 0) {
    options.resume = init.resumeClaudeSessionId;
    options.forkSession = false;
  }

  if (init.metadata?.projectRoot) {
    options.cwd = init.metadata.projectRoot;
  }

  // Resolve MCPs for this agent
  if (init.availableMcps) {
    try {
      const { resolveMcpServers } = await import('../services/mcp-resolver.js');
      const { loadAgentDefinition } = await import('../services/agent-definitions.js');

      // Load agent definition to get MCP configuration
      const agentDefinition = await loadAgentDefinition(init.agentType, {
        projectRoot: init.metadata?.projectRoot,
      });

      if (agentDefinition) {
        const mcpServers = resolveMcpServers({
          availableMcps: init.availableMcps,
          agentDefinition,
          parentMcps: init.parentMcps,
        });

        // Only set mcpServers if there are any to set
        if (Object.keys(mcpServers).length > 0) {
          options.mcpServers = mcpServers;
        }
      }
    } catch (error) {
      // MCP resolution failure - log but don't fail the agent
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'log', level: 'warn', message: `MCP resolution failed: ${message}` });
    }
  }

  // Add agent instructions as appended system prompt if provided
  if (init.outputStyle && init.outputStyle.trim().length > 0) {
    options.systemPrompt = init.outputStyle
    // Include both project and user settings to get user slash commands, skills, etc.
    options.settingSources = ['project', 'user'];
  }

  return options;
}

async function run(): Promise<void> {
  const init = await readRuntimeConfig();

  // Prompt is required
  const hasPrompt = init.prompt && init.prompt.trim().length > 0;
  if (!hasPrompt) {
    throw new Error('Prompt is required');
  }

  // outputStyle (agent instructions) is required
  const hasOutputStyle = init.outputStyle && init.outputStyle.trim().length > 0;
  if (!hasOutputStyle) {
    throw new Error('Agent instructions (outputStyle) are required');
  }

  const abortController = new AbortController();
  const options = await buildQueryOptions(init, abortController);

  let announcedSessionId = false;
  let finished = false;

  const finalize = (status: 'done' | 'failed' | 'interrupted', reason?: string): void => {
    if (finished) {
      return;
    }
    finished = true;
    emit({ type: 'done', status, reason });
  };

  const handleInterrupt = (signal: NodeJS.Signals): void => {
    emit({ type: 'log', level: 'warn', message: `Received signal ${signal}, aborting agent` });
    abortController.abort();
    finalize('interrupted', signal);
  };

  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);

  emit({ type: 'status', status: 'starting' });

  let stream: Query;
  try {
    // Use string prompt initially; messages will be handled separately
    stream = query({
      prompt: init.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message, stack: error instanceof Error ? error.stack : undefined });
    finalize('failed', message);
    throw error;
  }

  emit({ type: 'status', status: 'running' });

  // Track session ID for continuing conversation
  let currentSessionId: string | undefined;

  async function processQueryStream(queryStream: Query): Promise<void> {
    for await (const message of queryStream) {
      if (!announcedSessionId && message.session_id) {
        currentSessionId = message.session_id;
        emit({ type: 'claude-session', sessionId: message.session_id, transcriptPath: null });
        announcedSessionId = true;
      }

      // Log slash commands from init message
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        const initMessage = message as { slash_commands?: string[]; tools?: string[]; skills?: string[] };
        emit({
          type: 'log',
          level: 'info',
          message: `Available slash_commands: ${JSON.stringify(initMessage.slash_commands ?? [])}`,
        });
        emit({
          type: 'log',
          level: 'info',
          message: `Available tools: ${JSON.stringify(initMessage.tools ?? [])}`,
        });
        emit({
          type: 'log',
          level: 'info',
          message: `Available skills: ${JSON.stringify(initMessage.skills ?? [])}`,
        });
      }

      const text = extractMessageText(message);
      emit({
        type: 'message',
        messageType: message.type,
        payload: message,
        text,
      });

      if (message.type === 'result') {
        const resultMessage = message as SDKResultMessage;
        const resultPayload = (resultMessage as { result?: unknown }).result ?? null;
        emit({
          type: 'result',
          result: resultPayload,
          stopReason: resultMessage.subtype,
        });
      }
    }
  }

  async function listenForMessages(): Promise<void> {
    const rl = readline.createInterface({
      input: stdin,
      terminal: false,
    });

    for await (const line of rl) {
      if (abortController.signal.aborted) {
        rl.close();
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as { type?: string; prompt?: string };
        if (parsed.type === 'message' && parsed.prompt && currentSessionId) {
          emit({ type: 'log', level: 'info', message: `Received message: ${parsed.prompt.slice(0, 50)}...` });

          try {
            // Continue the exact same Claude session using explicit resume
            const continuedStream = query({
              prompt: parsed.prompt,
              options: {
                ...options,
                resume: currentSessionId,
                forkSession: false,
              },
            });

            await processQueryStream(continuedStream);
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            emit({ type: 'log', level: 'error', message: `Failed to process message: ${errMsg}` });
          }
        }
      } catch (parseError) {
        const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
        emit({ type: 'log', level: 'warn', message: `Failed to parse stdin message: ${errMsg}` });
      }
    }

    rl.close();
  }

  try {
    // Run the initial query
    await processQueryStream(stream);

    // Initial query is complete - mark session as completed immediately
    // This allows `klaude wait` and `klaude status` to reflect completion
    emit({ type: 'status', status: 'completed' });
    finalize('done');

    // Continue listening for additional messages (e.g., from `klaude message`)
    // This doesn't block session completion - the runtime stays alive for future messages
    emit({ type: 'log', level: 'info', message: 'Initial query complete, listening for additional messages on stdin' });
    await listenForMessages();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message, stack: error instanceof Error ? error.stack : undefined });
    finalize('failed', message);
    throw error;
  }
}

run()
  .then(() => exit(0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Agent runtime failed: ${message}\n`);
    exit(1);
  });
