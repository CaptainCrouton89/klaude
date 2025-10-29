import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { requestCheckout } from '@/services/instance-client.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';

/**
 * Register the 'klaude checkout' command.
 * Switches the Claude TUI to another Klaude session.
 */
export function registerCheckoutCommand(program: Command): void {
  program
    .command('checkout')
    .description('Switch the Claude TUI to another Klaude session')
    .argument('[sessionId]', 'Target session id (defaults to parent)')
    .option('--timeout <seconds>', 'Wait for hooks to deliver target session id', '5')
    .option('--instance <id>', 'Target instance id')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionId: string | undefined, options: OptionValues) => {
      try {
        const projectCwd = resolveProjectDirectory(options.cwd);
        const context = await prepareProjectContext(projectCwd);
        const instance = await resolveInstanceForProject(context, {
          instanceId: options.instance,
        });

        const timeoutSeconds =
          options.timeout === undefined || options.timeout === null
            ? undefined
            : Number(options.timeout);
        if (timeoutSeconds !== undefined && Number.isNaN(timeoutSeconds)) {
          throw new KlaudeError('Timeout value must be numeric', 'E_INVALID_TIMEOUT_VALUE');
        }

        const fromSessionId = process.env.KLAUDE_SESSION_ID;

        const response = await requestCheckout(instance.socketPath, {
          sessionId: sessionId ?? undefined,
          fromSessionId,
          waitSeconds: timeoutSeconds,
        });

        if (!response.ok) {
          throw new KlaudeError(response.error.message, response.error.code);
        }

        const result = response.result as { sessionId: string; claudeSessionId: string };
        console.log(
          `Checkout activated for session ${result.sessionId} (resume ${result.claudeSessionId}).`,
        );
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
