import path from 'node:path';
import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { listInstances } from '@/services/instance-registry.js';
import { getInstanceStatus } from '@/services/instance-client.js';
import { printError } from '@/utils/error-handler.js';

/**
 * Register the 'klaude instances' command.
 * Lists wrapper instances registered for this project.
 */
export function registerInstancesCommand(program: Command): void {
  program
    .command('instances')
    .description('List wrapper instances registered for this project')
    .option('-C, --cwd <path>', 'Project directory override')
    .option('--status', 'Query live status from active instances')
    .action(async (options: OptionValues) => {
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
}
