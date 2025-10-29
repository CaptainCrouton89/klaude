import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import {
  closeDatabase,
  getProjectByHash,
  getSessionById,
  initializeDatabase,
} from '@/db/index.js';
import { printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';

/**
 * Terminal session statuses that indicate completion
 */
const TERMINAL_STATUSES = ['done', 'failed', 'interrupted'] as const;

/**
 * Check if a session has reached a terminal state
 */
function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status as typeof TERMINAL_STATUSES[number]);
}

/**
 * Register the 'klaude wait' command.
 * Blocks until one or more agent sessions complete.
 */
export function registerWaitCommand(program: Command): void {
  program
    .command('wait')
    .description('Block until agent session(s) complete')
    .argument('<sessionIds...>', 'One or more session IDs to wait for')
    .option('--timeout <seconds>', 'Maximum wait time in seconds (default: no limit)', undefined)
    .option('--any', 'Return when ANY session completes (default: wait for ALL)', false)
    .option('--interval <ms>', 'Poll interval in milliseconds', '500')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionIds: string[], options: OptionValues) => {
      try {
        const projectCwd = resolveProjectDirectory(options.cwd);
        const context = await prepareProjectContext(projectCwd);
        await initializeDatabase();

        try {
          const project = getProjectByHash(context.projectHash);
          if (!project) {
            console.error('❌ No project found. Initialize with `klaude` first.');
            process.exitCode = 1;
            return;
          }

          // Parse options
          const timeoutMs = options.timeout ? parseInt(options.timeout, 10) * 1000 : undefined;
          const intervalMs = parseInt(options.interval, 10);
          const waitForAny = options.any as boolean;

          // Validate session IDs exist and belong to this project
          const sessions = sessionIds.map((id) => {
            const session = getSessionById(id);
            if (!session) {
              throw new Error(`Session ${id} not found`);
            }
            if (session.project_id !== project.id) {
              throw new Error(`Session ${id} does not belong to this project`);
            }
            return session;
          });

          // Track start time for timeout
          const startTime = Date.now();

          // Show initial status
          console.log(`⏳ Waiting for ${waitForAny ? 'ANY' : 'ALL'} of ${sessionIds.length} session(s) to complete...`);
          for (const session of sessions) {
            console.log(`   ${session.id} [${session.status}]`);
          }

          // Poll loop
          while (true) {
            // Check timeout
            if (timeoutMs !== undefined && Date.now() - startTime > timeoutMs) {
              console.error(`\n❌ Timeout after ${options.timeout}s`);
              process.exitCode = 124; // Standard timeout exit code
              return;
            }

            // Query current status of all sessions
            const statuses = sessionIds.map((id) => {
              const session = getSessionById(id);
              return session ? session.status : null;
            });

            // Check completion conditions
            if (waitForAny) {
              // ANY: Return if at least one session is terminal
              const anyTerminal = statuses.some((status) => status && isTerminal(status));
              if (anyTerminal) {
                console.log('\n✅ At least one session completed');
                for (let i = 0; i < sessionIds.length; i++) {
                  const status = statuses[i];
                  if (status && isTerminal(status)) {
                    console.log(`   ${sessionIds[i]} → ${status}`);
                  }
                }
                return;
              }
            } else {
              // ALL: Return if all sessions are terminal
              const allTerminal = statuses.every((status) => status && isTerminal(status));
              if (allTerminal) {
                console.log('\n✅ All sessions completed');
                for (let i = 0; i < sessionIds.length; i++) {
                  console.log(`   ${sessionIds[i]} → ${statuses[i]}`);
                }
                return;
              }
            }

            // Sleep before next poll
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
          }
        } finally {
          closeDatabase();
        }
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
