import { requestCheckout, startAgentSession } from '@/services/instance-client.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import { prepareProjectContext } from '@/services/project-context.js';
import { resolveProjectDirectory, abbreviateSessionId } from '@/utils/cli-helpers.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { Command, OptionValues } from 'commander';

/**
 * Register the 'klaude start' command.
 * Starts a new agent session in the active wrapper instance.
 */
export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start a new agent session in the active wrapper instance')
    .argument('<agentType>', 'Agent type identifier (e.g., planner, programmer)')
    .argument('<prompt>', 'Prompt or task description for the agent')
    .argument('[agentCount]', 'Optional agent count for fan-out requests')
    .option('-c, --checkout', 'Request immediate checkout after start')
    .option('-s, --share', 'Share current context with the new agent')
    .option('-v, --verbose', 'Verbose: print debug details (instance, log path)')
    .option('--instance <id>', 'Target instance id')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (agentType: string, prompt: string, agentCountArg: string | undefined, options: OptionValues) => {
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
          },
        };

        const response = await startAgentSession(instance.socketPath, payload);
        if (!response.ok) {
          throw new KlaudeError(response.error.message, response.error.code);
        }

        const result = response.result;
        const runtimeKind = result.runtimeKind ?? 'claude';
        const abbrevId = abbreviateSessionId(result.sessionId);

        if (options.verbose) {
          console.log(`Started agent session ${abbrevId} (${result.agentType})`);
          console.log(`Instance: ${result.instanceId}`);
          console.log(`Status: ${result.status}`);
          console.log(`Log: ${result.logPath}`);
        }

        // By default, print concise, agent-friendly hints
        if (!options.verbose) {
          console.log(`session: ${abbrevId} (agent=${result.agentType})`);
          console.log('Next steps:');
          console.log(`  - Tail output:   klaude logs ${abbrevId} -f`);
          console.log(`  - Check status:  klaude status ${abbrevId}`);
          console.log(`  - Wait for done: klaude wait ${abbrevId}`);
          if (runtimeKind === 'claude') {
            console.log(`  - Enter TUI:     klaude checkout ${abbrevId}`);
            console.log(`  - Message:       klaude message ${abbrevId} "<prompt>" --timeout 5`);
          } else {
            console.log(`  - Rerun prompt:  klaude start ${result.agentType} "<prompt>"`);
          }
          console.log(`  - Interrupt:     klaude interrupt ${abbrevId}`);
          if (runtimeKind === 'cursor') {
            console.log('Note: Cursor sessions do not support checkout or message flows.');
          }
        }

        const requestedCheckout = Boolean(payload.options?.checkout);
        const checkoutSupported = runtimeKind === 'claude';

        if (requestedCheckout && !checkoutSupported) {
          console.log('Checkout is not supported for cursor-backed agents; ignoring --checkout.');
        } else if (requestedCheckout) {
          // For fresh sessions, wait longer to ensure Claude has fully persisted the conversation
          // before attempting to resume it. This prevents "No conversation found" errors.
          const checkoutResponse = await requestCheckout(instance.socketPath, {
            sessionId: result.sessionId,
            waitSeconds: 15,
          });
          if (!checkoutResponse.ok) {
            throw new KlaudeError(checkoutResponse.error.message, checkoutResponse.error.code);
          }
          const checkoutResult = checkoutResponse.result;
          if (options.verbose) {
            console.log(
              `Checkout activated for session ${abbreviateSessionId(checkoutResult.sessionId)} (resume ${checkoutResult.claudeSessionId}).`,
            );
          } else {
            console.log(`session: ${abbreviateSessionId(checkoutResult.sessionId)} (entered via resume)`);
          }
        }
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
