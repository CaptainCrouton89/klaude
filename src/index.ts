#!/usr/bin/env node

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Command, OptionValues } from 'commander';

import {
  handleSessionEndHook,
  handleSessionStartHook,
} from '@/hooks/session-hooks.js';
import type { ClaudeHookPayload } from '@/hooks/session-hooks.js';
import { listInstances } from '@/services/instance-registry.js';
import { prepareProjectContext } from '@/services/project-context.js';
import {
  getInstanceStatus,
  startAgentSession,
  requestCheckout,
  sendAgentMessage,
  interruptAgent,
} from '@/services/instance-client.js';
import { startWrapperInstance } from '@/services/wrapper-instance.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import {
  closeDatabase,
  getProjectByHash,
  initializeDatabase,
  listSessionsByProject,
} from '@/db/index.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import { loadConfig } from '@/services/config-loader.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';

const program = new Command();

program
  .name('klaude')
  .description('Multi-agent wrapper for Claude Code sessions')
  .option('-C, --cwd <path>', 'Project directory override');

function resolveProjectDirectory(cwdOption?: string): string {
  return cwdOption ? path.resolve(cwdOption) : process.cwd();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }

  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    process.stdin.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.once('error', (error) => {
      reject(error);
    });
  });
}

program
  .command('hook')
  .description('Internal hook command invoked by Claude')
  .argument('<event>', 'Hook event (session-start | session-end)')
  .action(async (event: string) => {
    try {
      const rawPayload = await readStdin();
      if (!rawPayload) {
        throw new KlaudeError('Hook payload required on stdin', 'E_HOOK_PAYLOAD_MISSING');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawPayload);
      } catch (error) {
        throw new KlaudeError(
          `Invalid hook payload JSON: ${(error as Error).message}`,
          'E_HOOK_PAYLOAD_INVALID',
        );
      }

      switch (event) {
        case 'session-start':
          await handleSessionStartHook(payload as ClaudeHookPayload);
          break;
        case 'session-end':
          await handleSessionEndHook(payload as ClaudeHookPayload);
          break;
        default:
          throw new KlaudeError(
            `Unsupported hook event: ${event}`,
            'E_UNSUPPORTED_HOOK_EVENT',
          );
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('start')
  .description('Start a new agent session in the active wrapper instance')
  .argument('<agentType>', 'Agent type identifier (e.g., planner, programmer)')
  .argument('<prompt>', 'Prompt or task description for the agent')
  .argument('[agentCount]', 'Optional agent count for fan-out requests')
  .option('-c, --checkout', 'Request immediate checkout after start')
  .option('-s, --share', 'Share current context with the new agent')
  .option('-d, --detach', 'Do not attach to the agent stream')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (agentType, prompt, agentCountArg, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const agentCount =
        agentCountArg === undefined || agentCountArg === null
          ? undefined
          : Number(agentCountArg);
      if (agentCount !== undefined && Number.isNaN(agentCount)) {
        throw new KlaudeError('Agent count must be numeric', 'E_INVALID_AGENT_COUNT');
      }

      const payload = {
        agentType,
        prompt,
        agentCount,
        options: {
          checkout: Boolean(options.checkout),
          share: Boolean(options.share),
          detach: Boolean(options.detach),
        },
      };

      const response = await startAgentSession(instance.socketPath, payload);
      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      const result = response.result;
      console.log(`Started agent session ${result.sessionId} (${result.agentType})`);
      console.log(`Instance: ${result.instanceId}`);
      console.log(`Status: ${result.status}`);
      console.log(`Log: ${result.logPath}`);

      if (payload.options?.checkout) {
        const checkoutResponse = await requestCheckout(instance.socketPath, {
          sessionId: result.sessionId,
          waitSeconds: 5,
        });
        if (!checkoutResponse.ok) {
          throw new KlaudeError(checkoutResponse.error.message, checkoutResponse.error.code);
        }
        const checkoutResult = checkoutResponse.result;
        console.log(
          `Checkout activated for session ${checkoutResult.sessionId} (resume ${checkoutResult.claudeSessionId}).`,
        );
      }
      if (payload.options?.detach) {
        console.log('Detached mode not yet available; session created for tracking only.');
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('instances')
  .description('List wrapper instances registered for this project')
  .option('-C, --cwd <path>', 'Project directory override')
  .option('--status', 'Query live status from active instances')
  .action(async (options) => {
    try {
      const projectCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      const context = await prepareProjectContext(projectCwd);
      const instances = await listInstances(context);

      if (instances.length === 0) {
        console.log('No wrapper instances registered for this project.');
        return;
      }

      console.log(`Project: ${context.projectRoot} (${context.projectHash})`);
      console.log(`Instances: ${instances.length}`);

      const includeStatus = Boolean(options.status);

      for (const entry of instances.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        const state = entry.endedAt ? `ended ${entry.endedAt}` : 'running';
        let statusInfo = '';

        if (includeStatus && !entry.endedAt) {
          try {
            const statusResponse = await getInstanceStatus(entry.socketPath);
            if (statusResponse.ok) {
              const result = statusResponse.result;
              statusInfo = `session=${result.rootSessionId} state=${result.sessionStatus} claudePid=${result.claudePid ?? 'n/a'}`;
            } else {
              statusInfo = `status_error=${statusResponse.error.code}`;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            statusInfo = `status_error=${message}`;
          }
        }

        const parts = [
          entry.instanceId,
          `pid=${entry.pid}`,
          `tty=${entry.tty ?? 'n/a'}`,
          state,
        ];
        if (statusInfo) {
          parts.push(statusInfo);
        }

        console.log(parts.join(' | '));
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('checkout')
  .description('Switch the Claude TUI to another Klaude session')
  .argument('[sessionId]', 'Target session id (defaults to parent)')
  .option('--wait <seconds>', 'Wait for hooks to deliver target session id', '5')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string | undefined, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const waitSeconds =
        options.wait === undefined || options.wait === null
          ? undefined
          : Number(options.wait);
      if (waitSeconds !== undefined && Number.isNaN(waitSeconds)) {
        throw new KlaudeError('Wait value must be numeric', 'E_INVALID_WAIT_VALUE');
      }

      const response = await requestCheckout(instance.socketPath, {
        sessionId: sessionId ?? undefined,
        waitSeconds,
      });

      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      console.log('Checkout request sent to wrapper instance.');
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('message')
  .description('Send a message to a running agent session')
  .argument('<sessionId>', 'Target session id')
  .argument('<prompt>', 'Message content')
  .option('-w, --wait <seconds>', 'Wait for response (default 5)', '5')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string, prompt: string, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const waitSeconds =
        options.wait === undefined || options.wait === null
          ? undefined
          : Number(options.wait);
      if (waitSeconds !== undefined && Number.isNaN(waitSeconds)) {
        throw new KlaudeError('Wait value must be numeric', 'E_INVALID_WAIT_VALUE');
      }

      const response = await sendAgentMessage(instance.socketPath, {
        sessionId,
        prompt,
        waitSeconds,
      });

      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      console.log('Message submitted to wrapper instance.');
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('interrupt')
  .description('Send an interrupt signal to a running agent session')
  .argument('<sessionId>', 'Target session id')
  .option('--signal <signal>', 'POSIX signal to send (default SIGINT)')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const response = await interruptAgent(instance.socketPath, {
        sessionId,
        signal: options.signal,
      });

      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      console.log('Interrupt request sent to wrapper instance.');
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('sessions')
  .description('List sessions recorded for this project')
  .option('-v, --verbose', 'Show additional metadata for each session')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      await initializeDatabase();
      try {
        const project = getProjectByHash(context.projectHash);
        if (!project) {
          console.log('No sessions recorded yet.');
          return;
        }

        const sessions = listSessionsByProject(project.id);
        if (sessions.length === 0) {
          console.log('No sessions recorded yet.');
          return;
        }

        for (const session of sessions) {
          const baseLine = [
            session.id,
            `type=${session.agent_type}`,
            `status=${session.status}`,
            `instance=${session.instance_id ?? 'n/a'}`,
            `created=${session.created_at}`,
          ].join(' | ');
          console.log(baseLine);

          if (options.verbose) {
            if (session.prompt) {
              console.log(`  prompt: ${session.prompt}`);
            }
            if (session.last_claude_session_id) {
              console.log(`  claude_session: ${session.last_claude_session_id}`);
            }
            if (session.last_transcript_path) {
              console.log(`  transcript: ${session.last_transcript_path}`);
            }
          }
        }
      } finally {
        closeDatabase();
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('read')
  .description('Read a Klaude session log')
  .argument('<sessionId>', 'Session id to read')
  .option('-t, --tail', 'Tail the log continuously')
  .option('-s, --summary', 'Print a brief summary instead of full log')
  .option('--instance <id>', 'Target instance id for live tailing')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string, options) => {
    try {
      if (options.tail) {
        throw new KlaudeError('Tail mode is not available yet', 'E_TAIL_UNAVAILABLE');
      }
      if (options.summary) {
        throw new KlaudeError('Summary mode is not available yet', 'E_SUMMARY_UNAVAILABLE');
      }

      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const config = await loadConfig();

      const logPath = getSessionLogPath(
        context.projectHash,
        sessionId,
        config.wrapper?.projectsDir,
      );

      try {
        const content = await fsp.readFile(logPath, 'utf-8');
        if (content.length === 0) {
          console.log('(log is empty)');
        } else {
          process.stdout.write(content);
          if (!content.endsWith('\n')) {
            process.stdout.write('\n');
          }
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            throw new KlaudeError(
              `Log file not found for session ${sessionId}`,
              'E_LOG_NOT_FOUND',
            );
          }
        }
        throw error;
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program.action(async (options: OptionValues) => {
  try {
    const projectCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
    await startWrapperInstance({ projectCwd });
  } catch (error) {
    printError(error);
    process.exitCode = process.exitCode ?? 1;
  }
});

program.parseAsync(process.argv).catch((error) => {
  printError(error);
  process.exitCode = process.exitCode ?? 1;
});
