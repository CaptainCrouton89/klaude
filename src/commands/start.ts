import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { startAgentSession, requestCheckout } from '@/services/instance-client.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';
import { tailSessionLog } from '@/services/session-log.js';

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
    .option('-a, --attach', 'Attach to agent stream (blocks until completion)')
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

        if (options.verbose) {
          console.log(`Started agent session ${result.sessionId} (${result.agentType})`);
          console.log(`Instance: ${result.instanceId}`);
          console.log(`Status: ${result.status}`);
          console.log(`Log: ${result.logPath}`);
        }

        // By default, print concise, agent-friendly hints (but not in attach mode)
        if (!options.verbose && !options.attach) {
          console.log(`session: ${result.sessionId} (agent=${result.agentType})`);
          console.log('Next steps:');
          console.log(`  - Tail output:   klaude logs ${result.sessionId} -f`);
          console.log(`  - Check status:  klaude status ${result.sessionId}`);
          console.log(`  - Wait for done: klaude wait ${result.sessionId}`);
          if (runtimeKind === 'claude') {
            console.log(`  - Enter TUI:     klaude checkout ${result.sessionId}`);
            console.log(`  - Message:       klaude message ${result.sessionId} "<prompt>" --timeout 5`);
          } else {
            console.log(`  - Rerun prompt:  klaude start ${result.agentType} "<prompt>"`);
          }
          console.log(`  - Interrupt:     klaude interrupt ${result.sessionId}`);
          if (runtimeKind === 'cursor') {
            console.log('Note: Cursor sessions do not support checkout or message flows.');
          }
        }

        const requestedCheckout = Boolean(payload.options?.checkout);
        const checkoutSupported = runtimeKind === 'claude';
        let checkoutPerformed = false;

        if (requestedCheckout && !checkoutSupported) {
          console.log('Checkout is not supported for cursor-backed agents; ignoring --checkout.');
        } else if (requestedCheckout) {
          const checkoutResponse = await requestCheckout(instance.socketPath, {
            sessionId: result.sessionId,
            waitSeconds: 5,
          });
          if (!checkoutResponse.ok) {
            throw new KlaudeError(checkoutResponse.error.message, checkoutResponse.error.code);
          }
          const checkoutResult = checkoutResponse.result;
          checkoutPerformed = true;
          if (options.verbose) {
            console.log(
              `Checkout activated for session ${checkoutResult.sessionId} (resume ${checkoutResult.claudeSessionId}).`,
            );
          } else {
            console.log(`session: ${checkoutResult.sessionId} (entered via resume)`);
          }
        }
        // Attach only if explicitly requested
        if (options.attach && !checkoutPerformed) {
          await tailSessionLog(result.logPath, { untilExit: true, raw: Boolean(options.verbose) });
        }
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
