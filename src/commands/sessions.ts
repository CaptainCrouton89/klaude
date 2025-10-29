import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import {
  calculateSessionDepth,
  closeDatabase,
  getProjectByHash,
  initializeDatabase,
  listSessionsByProject,
} from '@/db/index.js';
import { printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';

/**
 * Register the 'klaude sessions' command.
 * Lists sessions recorded for this project.
 */
export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List sessions recorded for this project')
    .option('-v, --verbose', 'Show additional metadata for each session')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (options: OptionValues) => {
      try {
        const projectCwd = resolveProjectDirectory(options.cwd);
        const context = await prepareProjectContext(projectCwd);
        await initializeDatabase();
        try {
          const project = getProjectByHash(context.projectHash);
          if (!project) {
            console.log('No sessions recorded yet.');
            return;
          }

          const sessions = listSessionsByProject(project.id);
          if (sessions.length === 0) {
            console.log('No sessions recorded yet.');
            return;
          }

          for (const session of sessions) {
            const baseLine = [
              session.id,
              `type=${session.agent_type}`,
              `status=${session.status}`,
              `instance=${session.instance_id ?? 'n/a'}`,
              `created=${session.created_at}`,
            ].join(' | ');
            console.log(baseLine);

            if (options.verbose) {
              const depth = calculateSessionDepth(session.id);
              console.log(`  depth: ${depth}`);
              if (session.prompt) {
                console.log(`  prompt: ${session.prompt}`);
              }
              if (session.last_claude_session_id) {
                console.log(`  claude_session: ${session.last_claude_session_id}`);
              }
              if (session.last_transcript_path) {
                console.log(`  transcript: ${session.last_transcript_path}`);
              }
            }
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
