#!/usr/bin/env node

import path from 'node:path';
import { Command, OptionValues } from 'commander';

import {
  handleSessionEndHook,
  handleSessionStartHook,
} from '@/hooks/session-hooks.js';
import type { ClaudeHookPayload } from '@/hooks/session-hooks.js';
import { listInstances } from '@/services/instance-registry.js';
import { prepareProjectContext } from '@/services/project-context.js';
import { getInstanceStatus } from '@/services/instance-client.js';
import { startWrapperInstance } from '@/services/wrapper-instance.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';

const program = new Command();

program
  .name('klaude')
  .description('Multi-agent wrapper for Claude Code sessions')
  .option('-C, --cwd <path>', 'Project directory override');

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
