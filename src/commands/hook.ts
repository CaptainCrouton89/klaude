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

          await handleSessionStartHook(payload as ClaudeHookPayload);

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
          const response = {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: `ERROR: The Task tool is replaced with \`klaude start <agent_type> <prompt> [options]\`. You MUST re-delegate this task, but use the klaude instead.

To spawn an agent, use:
  klaude start <agent_type> <prompt> [options]

Available options:
  --attach    Attach to agent in foreground (blocks until complete). Do  this when the task is a dependency for a known next step.
  --detach    Run agent in background (default).`
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

          if (result.systemMessage) {
            const response = {
              hookSpecificOutput: {
                hookEventName: 'PreUserMessage',
                systemMessage: result.systemMessage,
              },
            };
            process.stdout.write(JSON.stringify(response) + '\n');
          }
          // If no system message (no @agent- pattern detected), no response = allow through
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
}
