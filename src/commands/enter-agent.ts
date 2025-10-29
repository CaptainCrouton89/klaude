import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { requestCheckout } from '@/services/instance-client.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';

/**
 * Register the 'klaude enter-agent' command.
 * Alias for checkout - switches the Claude TUI to another Klaude session.
 */
export function registerEnterAgentCommand(program: Command): void {
  program
    .command('enter-agent')
    .description('Switch the Claude TUI to another Klaude session (alias for checkout)')
    .argument('[sessionId]', 'Target session id (defaults to parent)')
    .option('--wait <seconds>', 'Wait for hooks to deliver target session id', '5')
    .option('--instance <id>', 'Target instance id')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionId: string | undefined, options: OptionValues) => {
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

        const fromSessionId = process.env.KLAUDE_SESSION_ID;

        const response = await requestCheckout(instance.socketPath, {
          sessionId: sessionId ?? undefined,
          fromSessionId,
          waitSeconds,
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
