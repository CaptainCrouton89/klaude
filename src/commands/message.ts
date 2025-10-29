import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { sendAgentMessage } from '@/services/instance-client.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';
import { loadConfig } from '@/services/config-loader.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import { waitForFirstAssistantOutput } from '@/services/session-log.js';

/**
 * Register the 'klaude message' command.
 * Sends a message to a running agent session.
 */
export function registerMessageCommand(program: Command): void {
  program
    .command('message')
    .description('Send a message to a running agent session')
    .argument('<sessionId>', 'Target session id')
    .argument('<prompt>', 'Message content')
    .option('-w, --wait <seconds>', 'Wait for response (default 5)', '5')
    .option('--instance <id>', 'Target instance id')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionId: string, prompt: string, options: OptionValues) => {
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

        const result = response.result as { status?: string; messagesQueued?: number } | undefined;
        const status = result && typeof result.status === 'string' ? result.status : 'submitted';
        const queued = result && typeof result.messagesQueued === 'number' ? result.messagesQueued : 1;
        console.log(`Message ${status} (${queued} message${queued === 1 ? '' : 's'} queued).`);

        if (waitSeconds && waitSeconds > 0) {
          // Follow the session log briefly and stop on first assistant output
          const config = await loadConfig();
          const logPath = getSessionLogPath(
            context.projectHash,
            sessionId,
            config.wrapper?.projectsDir,
          );
          const found = await waitForFirstAssistantOutput(logPath, waitSeconds);
          if (!found) {
            console.log(`(no response within ${waitSeconds}s)`);
          }
        }
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
