import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import {
  closeDatabase,
  getProjectByHash,
  getSessionById,
  initializeDatabase,
} from '@/db/index.js';
import { printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory, abbreviateSessionId } from '@/utils/cli-helpers.js';
import { resolveSessionId } from '@/db/models/session.js';

/**
 * Register the 'klaude status' command.
 * Quick non-blocking status check for agent session(s).
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check status of agent session(s)')
    .argument('<sessionIds...>', 'One or more session IDs to check')
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

          // Query each session
          let hasErrors = false;
          for (const sessionId of sessionIds) {
            // Resolve abbreviated session ID
            let resolvedSessionId: string;
            try {
              resolvedSessionId = resolveSessionId(sessionId, project.id);
            } catch {
              console.log(`❌ ${sessionId}: not found`);
              hasErrors = true;
              continue;
            }

            const session = getSessionById(resolvedSessionId);

            if (!session) {
              console.log(`❌ ${sessionId}: not found`);
              hasErrors = true;
              continue;
            }

            if (session.project_id !== project.id) {
              console.log(`❌ ${sessionId}: not in this project`);
              hasErrors = true;
              continue;
            }

            // Format status with appropriate emoji
            const statusIcon =
              session.status === 'done' ? '✅' :
              session.status === 'failed' ? '❌' :
              session.status === 'interrupted' ? '⚠️' :
              session.status === 'running' ? '🔄' :
              '⏸️'; // active

            // Calculate time since last update
            const updatedAt = session.updated_at || session.created_at;
            const timeSince = new Date(updatedAt).toLocaleString();

            console.log(
              `${statusIcon} ${abbreviateSessionId(session.id)} | agent: ${session.agent_type} | status: ${session.status} | updated: ${timeSince}`
            );
          }

          if (hasErrors) {
            process.exitCode = 1;
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
