import chalk from 'chalk';
import { Command } from 'commander';
import { listPendingUpdatesByParent, markUpdateAcknowledged, getSessionById } from '@/db/index.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';
import { prepareProjectContext } from '@/services/project-context.js';

interface WatchOptions {
  interval?: number;
  filter?: string;
  once?: boolean;
  acknowledge?: boolean;
}

function getTimeString(): string {
  const now = new Date();
  return chalk.gray(
    now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  );
}

function formatUpdateLine(
  timestamp: string,
  agentType: string,
  sessionSuffix: string,
  updateText: string,
): string {
  const typeStr = chalk.cyan(`[${agentType}]`);
  const suffixStr = chalk.yellow(`(${sessionSuffix})`);
  return `${timestamp} ${typeStr} ${suffixStr} ${updateText}`;
}

async function watchUpdates(sessionId: string, options: WatchOptions): Promise<void> {
  const interval = options.interval ?? 3;
  const filterRegex = options.filter ? new RegExp(options.filter, 'i') : null;

  let lastSeenId = 0;
  let seenCount = 0;

  while (true) {
    try {
      const updates = listPendingUpdatesByParent(sessionId);

      // Filter updates by ID (to avoid showing duplicates on repeated polls)
      const newUpdates = updates.filter((u) => u.id > lastSeenId);

      // Filter by regex pattern if specified
      const filteredUpdates = filterRegex ? newUpdates.filter((u) => filterRegex.test(u.update_text)) : newUpdates;

      // Display updates
      for (const update of filteredUpdates) {
        const session = getSessionById(update.session_id);
        if (session) {
          const agentType = session.agent_type || 'unknown';
          const sessionSuffix = update.session_id.slice(-6);
          const timestamp = getTimeString();

          const line = formatUpdateLine(timestamp, agentType, sessionSuffix, update.update_text);
          console.log(line);

          // Mark as acknowledged if requested
          if (options.acknowledge) {
            try {
              markUpdateAcknowledged(update.id);
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              console.error(chalk.red(`Failed to acknowledge update: ${msg}`));
            }
          }

          lastSeenId = update.id;
          seenCount++;
        }
      }

      // Exit if --once flag was used
      if (options.once) {
        break;
      }

      // Sleep before next poll
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Watch error: ${message}`));
      // Continue polling on errors
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
  }
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch [session-id]')
    .description('Watch for updates from child agents')
    .option(
      '--interval <seconds>',
      'Poll interval in seconds (default: 3)',
      (val) => parseInt(val, 10),
      3,
    )
    .option('--filter <pattern>', 'Regex pattern to filter updates')
    .option('--once', 'Poll once and exit')
    .option('--acknowledge', 'Mark updates as acknowledged after display')
    .action(async (sessionIdArg: string | undefined, options: WatchOptions) => {
      try {
        // Resolve project directory
        const cwd = resolveProjectDirectory(process.cwd());

        // Prepare project context
        const context = await prepareProjectContext(cwd);

        // Session ID must be provided or resolved from context
        let targetSessionId = sessionIdArg;
        if (!targetSessionId) {
          throw new KlaudeError('Session ID is required. Usage: klaude watch <session-id>', 'E_SESSION_ID_REQUIRED');
        }

        // Display header
        const header = chalk.blue(`Watching for updates from parent session: ${chalk.bold(targetSessionId)}`);
        console.log(header);
        if (options.filter) {
          console.log(chalk.gray(`Filter pattern: ${options.filter}`));
        }
        console.log(''); // Blank line

        // Start watching
        await watchUpdates(targetSessionId, options);
      } catch (error) {
        printError(error);
        process.exit(1);
      }
    });
}
