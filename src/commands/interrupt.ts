import { interruptAgent } from '@/services/instance-client.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import { prepareProjectContext } from '@/services/project-context.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { Command, OptionValues } from 'commander';
import { resolveSessionId } from '@/db/models/session.js';
import { initializeDatabase, closeDatabase, getProjectByHash } from '@/db/index.js';

/**
 * Register the 'klaude interrupt' command.
 * Sends an interrupt signal to a running agent session.
 */
export function registerInterruptCommand(program: Command): void {
  program
    .command('interrupt')
    .description('Send an interrupt signal to a running agent session')
    .argument('<sessionId>', 'Target session id')
    .option('--signal <signal>', 'POSIX signal to send (default SIGINT)')
    .option('--instance <id>', 'Target instance id')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionId: string, options: OptionValues) => {
      try {
        const projectCwd = resolveProjectDirectory(options.cwd);
        const context = await prepareProjectContext(projectCwd);
        const instance = await resolveInstanceForProject(context, {
          instanceId: options.instance,
        });

        // Resolve abbreviated session ID
        await initializeDatabase();
        const project = getProjectByHash(context.projectHash);
        if (!project) {
          throw new KlaudeError('Project not found', 'E_PROJECT_NOT_FOUND');
        }
        const resolvedSessionId = resolveSessionId(sessionId, project.id);
        closeDatabase();

        const response = await interruptAgent(instance.socketPath, {
          sessionId: resolvedSessionId,
          signal: options.signal,
        });

        if (!response.ok) {
          throw new KlaudeError(response.error.message, response.error.code);
        }

        const result = response.result as { interrupted?: boolean; signal?: string } | undefined;
        const signal = result && typeof result.signal === 'string' ? result.signal : 'SIGINT';
        console.log(`Agent interrupted with ${signal}.`);
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
