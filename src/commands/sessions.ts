import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import {
  calculateSessionDepth,
  closeDatabase,
  getProjectByHash,
  initializeDatabase,
  listSessionsByProject,
} from '@/db/index.js';
import { printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory, abbreviateSessionId } from '@/utils/cli-helpers.js';

/**
 * Register the 'klaude sessions' command.
 * Lists sessions recorded for this project or instance.
 */
export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List sessions recorded for this instance')
    .option('-v, --verbose', 'Show additional metadata for each session')
    .option('-C, --cwd <path>', 'Project directory override')
    .option('--all', 'Show sessions from all instances in the project')
    .option('--instance <id>', 'Filter by specific instance ID')
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

          let allSessions = listSessionsByProject(project.id);
          if (allSessions.length === 0) {
            console.log('No sessions recorded yet.');
            return;
          }

          // Determine which instance to filter by
          let filterInstanceId: string | null = null;

          if (!options.all) {
            // By default, filter by current instance
            if (options.instance) {
              filterInstanceId = options.instance;
            } else {
              // Try to resolve current instance
              try {
                const currentInstance = await resolveInstanceForProject(context, {
                  envInstanceId: process.env.KLAUDE_INSTANCE_ID,
                });
                filterInstanceId = currentInstance.instanceId;
              } catch {
                // If we can't resolve an instance and --all is not set, fail
                throw new Error(
                  'Cannot determine current instance. Use --all to show all instances or --instance to specify one.',
                );
              }
            }
          } else if (options.instance) {
            // --all takes precedence but --instance should error if both specified
            throw new Error('Cannot use --all and --instance together');
          }

          // Filter sessions if needed
          if (filterInstanceId) {
            allSessions = allSessions.filter((s) => s.instance_id === filterInstanceId);
            if (allSessions.length === 0) {
              console.log(`No sessions recorded for instance ${filterInstanceId}.`);
              return;
            }
          }

          // Filter out tui sessions unless in verbose mode
          if (!options.verbose) {
            allSessions = allSessions.filter((s) => s.agent_type !== 'tui');
            if (allSessions.length === 0) {
              console.log('No sessions recorded.');
              return;
            }
          }

          for (const session of allSessions) {
            const parts = [abbreviateSessionId(session.id), `status=${session.status}`];

            // Show type and instance/date in verbose or when showing all instances
            if (options.verbose || options.all) {
              parts.splice(1, 0, `type=${session.agent_type}`);
            }

            // Only show instance and created date when showing all instances or verbose
            if (options.all || options.verbose) {
              const instanceStr = session.instance_id ? session.instance_id : 'n/a';
              parts.push(`instance=${instanceStr}`);
              parts.push(`created=${session.created_at}`);
            }

            console.log(parts.join(' | '));

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
