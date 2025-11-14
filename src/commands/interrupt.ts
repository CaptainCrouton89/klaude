import { interruptAgent } from '@/services/instance-client.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import { prepareProjectContext } from '@/services/project-context.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { Command, OptionValues } from 'commander';
import { resolveSessionId } from '@/db/models/session.js';
import { initializeDatabase, closeDatabase, getProjectByHash } from '@/db/index.js';

/**
 * Register the 'klaude interrupt' command.
 * Sends an interrupt signal to one or more running agent sessions.
 */
export function registerInterruptCommand(program: Command): void {
  program
    .command('interrupt')
    .description('Send an interrupt signal to one or more running agent sessions')
    .argument('<sessionIds...>', 'One or more target session ids')
    .option('--signal <signal>', 'POSIX signal to send (default SIGINT)')
    .option('--instance <id>', 'Target instance id')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionIds: string[], options: OptionValues) => {
      try {
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
          throw new KlaudeError('At least one session ID is required', 'E_NO_SESSION_IDS');
        }

        const projectCwd = resolveProjectDirectory(options.cwd);
        const context = await prepareProjectContext(projectCwd);
        const instance = await resolveInstanceForProject(context, {
          instanceId: options.instance,
        });

        // Resolve abbreviated session IDs to full IDs
        await initializeDatabase();
        const project = getProjectByHash(context.projectHash);
        if (!project) {
          throw new KlaudeError('Project not found', 'E_PROJECT_NOT_FOUND');
        }

        const resolvedSessionIds = sessionIds.map(id => resolveSessionId(id, project.id));
        closeDatabase();

        // Interrupt each session
        const results: Array<{ sessionId: string; success: boolean; signal?: string; error?: string }> = [];
        let hasErrors = false;

        for (const resolvedSessionId of resolvedSessionIds) {
          try {
            const response = await interruptAgent(instance.socketPath, {
              sessionId: resolvedSessionId,
              signal: options.signal,
            });

            if (!response.ok) {
              results.push({
                sessionId: resolvedSessionId,
                success: false,
                error: response.error.message,
              });
              hasErrors = true;
            } else {
              const result = response.result as { interrupted?: boolean; signal?: string } | undefined;
              const signal = result && typeof result.signal === 'string' ? result.signal : 'SIGINT';
              results.push({
                sessionId: resolvedSessionId,
                success: true,
                signal,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({
              sessionId: resolvedSessionId,
              success: false,
              error: message,
            });
            hasErrors = true;
          }
        }

        // Display results
        const successCount = results.filter(r => r.success).length;
        if (successCount === sessionIds.length) {
          console.log(`✅ Interrupted ${successCount} session${successCount === 1 ? '' : 's'}.`);
        } else if (successCount > 0) {
          console.log(
            `⚠️  Interrupted ${successCount}/${sessionIds.length} session${successCount === 1 ? '' : 's'}.`,
          );
          for (const result of results) {
            if (!result.success) {
              console.log(`   ❌ ${result.sessionId}: ${result.error}`);
            }
          }
        } else {
          throw new KlaudeError(
            `Failed to interrupt any sessions`,
            'E_ALL_INTERRUPTS_FAILED',
          );
        }

        if (hasErrors) {
          process.exitCode = 1;
        }
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
