import type { ClaudeHookPayload, PreUserMessagePayload } from '@/hooks/session-hooks.js';
import {
  handlePreUserMessageHook,
  handleSessionEndHook,
  handleSessionStartHook,
} from '@/hooks/session-hooks.js';
import { readStdin } from '@/utils/cli-helpers.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { Command } from 'commander';
import { promises as fsp } from 'node:fs';

/**
 * Register the 'klaude hook' command with all its subcommands.
 * Internal hook commands invoked by Claude via configured hooks.
 */
export function registerHookCommand(program: Command): void {
  const hookCmd = program
    .command('hook')
    .description('Internal hook command invoked by Claude');

  // session-start hook
  hookCmd.addCommand(
    new Command('session-start')
      .description('Handle Claude session start hook')
      .action(async () => {
        const event = 'session-start';
        const startTime = Date.now();
        const logLine = (msg: string) => {
          const timestamp = new Date().toISOString();
          const line = `[${timestamp}] [hook:${event}] ${msg}`;
          console.error(line);
          // Also write to persistent log (ignore write errors)
          fsp.appendFile('/tmp/klaude-hook.log', line + '\n').catch((logError) => {
            // Silently ignore log file write failures
            void logError;
          });
        };

        logLine(`HOOK STARTED - event=${event}, pid=${process.pid}`);

        try {
          logLine('Reading payload from stdin...');
          const rawPayload = await readStdin();
          logLine(`Received payload (${rawPayload.length} bytes)`);

          if (!rawPayload) {
            throw new KlaudeError('Hook payload required on stdin', 'E_HOOK_PAYLOAD_MISSING');
          }

          let payload: unknown;
          try {
            logLine('Parsing JSON payload...');
            payload = JSON.parse(rawPayload);
          } catch (error) {
            throw new KlaudeError(
              `Invalid hook payload JSON: ${(error as Error).message}`,
              'E_HOOK_PAYLOAD_INVALID',
            );
          }

          const result = await handleSessionStartHook(payload as ClaudeHookPayload);

          const elapsed = Date.now() - startTime;
          logLine(`HOOK SUCCEEDED - elapsed=${elapsed}ms`);

          // Write JSON output to stdout if present
          if (result) {
            process.stdout.write(result + '\n');
          }
        } catch (error) {
          const elapsed = Date.now() - startTime;
          const msg = error instanceof Error ? error.message : String(error);
          const code = error instanceof KlaudeError ? error.code : 'UNKNOWN';
          logLine(`HOOK FAILED - code=${code}, elapsed=${elapsed}ms, error=${msg}`);
          printError(error);
          throw error;
        }
      }),
  );

  // session-end hook
  hookCmd.addCommand(
    new Command('session-end')
      .description('Handle Claude session end hook')
      .action(async () => {
        const event = 'session-end';
        const startTime = Date.now();
        const logLine = (msg: string) => {
          const timestamp = new Date().toISOString();
          const line = `[${timestamp}] [hook:${event}] ${msg}`;
          console.error(line);
          // Also write to persistent log (ignore write errors)
          fsp.appendFile('/tmp/klaude-hook.log', line + '\n').catch((logError) => {
            // Silently ignore log file write failures
            void logError;
          });
        };

        logLine(`HOOK STARTED - event=${event}, pid=${process.pid}`);

        try {
          logLine('Reading payload from stdin...');
          const rawPayload = await readStdin();
          logLine(`Received payload (${rawPayload.length} bytes)`);

          if (!rawPayload) {
            throw new KlaudeError('Hook payload required on stdin', 'E_HOOK_PAYLOAD_MISSING');
          }

          let payload: unknown;
          try {
            logLine('Parsing JSON payload...');
            payload = JSON.parse(rawPayload);
          } catch (error) {
            throw new KlaudeError(
              `Invalid hook payload JSON: ${(error as Error).message}`,
              'E_HOOK_PAYLOAD_INVALID',
            );
          }

          await handleSessionEndHook(payload as ClaudeHookPayload);

          const elapsed = Date.now() - startTime;
          logLine(`HOOK SUCCEEDED - elapsed=${elapsed}ms`);
        } catch (error) {
          const elapsed = Date.now() - startTime;
          const msg = error instanceof Error ? error.message : String(error);
          const code = error instanceof KlaudeError ? error.code : 'UNKNOWN';
          logLine(`HOOK FAILED - code=${code}, elapsed=${elapsed}ms, error=${msg}`);
          printError(error);
          throw error;
        }
      }),
  );

  // task hook (blocks Task tool in klaude sessions)
  hookCmd.addCommand(
    new Command('task')
      .description('Handle Claude PreToolUse hook for Task tool blocking')
      .action(async () => {
        // Check if we're in a klaude session; if not, allow all tools
        if (!process.env.KLAUDE_PROJECT_HASH) {
          return; // Allow all tools (no response = allowed)
        }

        let rawPayload: string;
        try {
          rawPayload = await readStdin();
        } catch (stdinError) {
          const msg = stdinError instanceof Error ? stdinError.message : String(stdinError);
          console.error(`Task hook: Failed to read stdin: ${msg}`);
          process.exitCode = 1;
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawPayload);
        } catch (parseError) {
          console.error(`Task hook: Failed to parse JSON payload: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          process.exitCode = 1;
          return;
        }

        const toolName = (payload as { tool_name?: string }).tool_name;

        if (toolName === 'Task') {
          // Extract agent_type and prompt from tool input
          const payloadWithToolInput = payload as { tool_input?: { subagent_type?: string; prompt?: string; description?: string } };
          const toolInput = payloadWithToolInput.tool_input;

          if (!toolInput || !toolInput.subagent_type || !toolInput.prompt) {
            throw new Error(
              `Task tool input is required: subagent_type and prompt are required. Passed payload: ${JSON.stringify(payload)}`
            );
          }

          const agentType = toolInput.subagent_type;

          // Allow Plan and Explore agents to use native Task tool
          const TASK_TOOL_EXEMPT_AGENTS = ['Plan', 'Explore'];
          if (TASK_TOOL_EXEMPT_AGENTS.includes(agentType)) {
            return; // Allow through (no response = allowed)
          }

          const promptPreview = toolInput.prompt.slice(0, 10);

          const response = {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: `The Task tool is replaced with \`klaude start ${agentType} "${promptPreview}..." [options]\`. You MUST re-delegate this task, but use klaude instead. Treat this just like you would the Task tool, but use the klaude cli instead.

To start a task, use:
  klaude start ${agentType} "${promptPreview}..."`,
            },
          };
          process.stdout.write(JSON.stringify(response) + '\n');
        }
        // For other tools, allow them (no response needed)
      }),
  );

  // pre-user-message hook (detects @agent- pattern)
  hookCmd.addCommand(
    new Command('pre-user-message')
      .description('Handle Claude PreUserMessage hook for @agent- pattern detection')
      .action(async () => {
        // Check if we're in a klaude session; if not, allow all messages
        if (!process.env.KLAUDE_PROJECT_HASH) {
          return; // Allow message through (no response = allowed)
        }

        try {
          const rawPayload = await readStdin();
          if (!rawPayload) {
            // No payload provided; allow message through
            return;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(rawPayload);
          } catch (parseError) {
            throw new KlaudeError(
              `Invalid hook payload JSON: ${(parseError as Error).message}`,
              'E_HOOK_PAYLOAD_INVALID',
            );
          }

          const result = await handlePreUserMessageHook(payload as PreUserMessagePayload);

          if (result) {
            // Result is already JSON stringified from the hook
            process.stdout.write(result + '\n');
          }
          // If no result (no @agent- pattern detected), no response = allow through
        } catch (error) {
          let msg: string;
          let code: string;

          if (error instanceof KlaudeError) {
            msg = error.message;
            code = error.code;
          } else if (error instanceof Error) {
            msg = error.message;
            code = 'UNKNOWN';
          } else {
            msg = String(error);
            code = 'UNKNOWN';
          }

          console.error(`PreUserMessage hook failed: code=${code}, error=${msg}`);
          printError(error);
          throw error;
        }
      }),
  );

  // post-tool-use-updates hook (injects child agent updates as context)
  hookCmd.addCommand(
    new Command('post-tool-use-updates')
      .description('Handle PostToolUse hook to inject child agent updates')
      .action(async () => {
        // Check if we're in a klaude session; if not, allow all
        if (!process.env.KLAUDE_PROJECT_HASH) {
          return; // Exit silently (no output)
        }

        let rawPayload: string;
        try {
          rawPayload = await readStdin();
        } catch (stdinError) {
          // Silent error - don't block tool use
          const stdinMsg = stdinError instanceof Error ? stdinError.message : String(stdinError);
          console.error(`[PostToolUseUpdates] Failed to read stdin: ${stdinMsg}`);
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawPayload);
        } catch (parseError) {
          // Silent error - don't block tool use
          const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
          console.error(`[PostToolUseUpdates] Failed to parse payload: ${parseMsg}`);
          return;
        }

        try {
          const { initializeDatabase, listPendingUpdatesByParent, markUpdateAcknowledged, getSessionById } = await import('@/db/index.js');

          // Initialize database
          await initializeDatabase();

          // Get session ID from payload
          const sessionPayload = payload as { session_id?: string };
          const sessionId = sessionPayload.session_id;

          if (!sessionId) {
            return; // No session ID, exit silently
          }

          // Get session to verify it exists
          const session = getSessionById(sessionId);
          if (!session) {
            return; // Session not found, exit silently
          }

          // Query pending updates from children
          const updates = listPendingUpdatesByParent(sessionId);

          // If no updates, exit silently (no output)
          if (updates.length === 0) {
            return;
          }

          // Format updates with metadata
          const formattedUpdates = updates
            .map((update) => {
              const childSession = getSessionById(update.session_id);
              const agentType = childSession ? childSession.agent_type : 'unknown';
              const sessionSuffix = update.session_id.slice(-6);
              const timestamp = new Date(update.created_at).toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });

              return `[${timestamp}] [${agentType}] (${sessionSuffix}) ${update.update_text}`;
            })
            .join('\n');

          const contextBlock = `<notification>
Recent updates from child agents:
${formattedUpdates}
</notification>`;

          // Mark all updates as acknowledged
          for (const update of updates) {
            try {
              markUpdateAcknowledged(update.id);
            } catch (ackError) {
              // Non-fatal error - continue processing other updates
              const ackMsg = ackError instanceof Error ? ackError.message : String(ackError);
              console.error(`[PostToolUseUpdates] Failed to acknowledge update ${update.id}: ${ackMsg}`);
            }
          }

          // Output JSON response with injected context
          const response = {
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: contextBlock,
            },
          };

          process.stdout.write(JSON.stringify(response) + '\n');
        } catch (error) {
          // Non-fatal error - log but don't fail hook
          if (error instanceof Error) {
            console.error(`[PostToolUseUpdates] Error: ${error.message}`);
            if (error.stack) {
              console.error(`[PostToolUseUpdates] Stack: ${error.stack}`);
            }
          } else {
            console.error(`[PostToolUseUpdates] Error: ${String(error)}`);
          }
          // Exit 0 to not block tool use
        }
      }),
  );
}
