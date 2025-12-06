import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { loadConfig } from '@/services/config-loader.js';
import {
  closeDatabase,
  getProjectByHash,
  getSessionById,
  initializeDatabase,
} from '@/db/index.js';
import { printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory, abbreviateSessionId } from '@/utils/cli-helpers.js';
import { resolveSessionId } from '@/db/models/session.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import { collectCompletionInfo, saveAgentOutput } from '@/services/session-log.js';
import { loadAgentDefinition } from '@/services/agent-definitions.js';

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
 * Format and display completion summary for a session
 */
async function displaySessionSummary(
  sessionId: string,
  status: string,
  projectHash: string,
  projectRoot: string,
  agentType: string | null,
  projectsDir?: string
): Promise<void> {
  console.log(`Agent ${abbreviateSessionId(sessionId)} response:`);

  // Try to get completion info from log
  try {
    const logPath = getSessionLogPath(projectHash, sessionId, projectsDir);
    const info = await collectCompletionInfo(logPath);

    // Check if agent has outputDir configured and save output
    let savedPath: string | null = null;
    if (agentType && info.finalText && status === 'done') {
      const agentDef = await loadAgentDefinition(agentType, { projectRoot });
      if (agentDef?.outputDir) {
        try {
          savedPath = await saveAgentOutput(projectRoot, agentDef.outputDir, info.finalText);
        } catch {
          // Silently fail if we can't save (e.g., permission issues)
        }
      }
    }

    // Display saved file path first if applicable
    if (savedPath) {
      console.log();
      console.log('Created:');
      console.log(savedPath);
    }

    // Display file changes
    const hasFileChanges = info.filesEdited.length > 0 || info.filesCreated.length > 0;
    if (hasFileChanges) {
      if (!savedPath) {
        console.log(); // blank line before file list (only if we didn't already print saved path)
      }
      if (info.filesEdited.length > 0) {
        if (!savedPath) {
          console.log('Edited:');
        }
        for (const file of info.filesEdited) {
          console.log(file);
        }
        if (info.filesCreated.length > 0) {
          console.log(); // blank line between lists
        }
      }
      if (info.filesCreated.length > 0) {
        if (!savedPath) {
          console.log('Created:');
        }
        for (const file of info.filesCreated) {
          console.log(file);
        }
      }
    }

    // Display error or final response
    if (info.error) {
      console.log();
      console.log(`Error: ${info.error.split('\n')[0]}`); // First line only
    } else if (savedPath) {
      // Output was saved to file - show concise message with handoff instructions
      console.log();
      console.log(`Share this file with implementing agents if needed.`);
    } else if (info.finalText) {
      console.log();
      console.log(info.finalText);
    }
  } catch {
    // Silently fall back to status-only display if log parsing fails
    // (warning already printed above with status)
  }
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
    .option('--timeout <seconds>', 'Maximum wait time in seconds (default: 570)', '570')
    .option('--any', 'Return when ANY session completes (default: wait for ALL)', false)
    .option('--interval <ms>', 'Poll interval in milliseconds', '500')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionIds: string[], options: OptionValues) => {
      try {
        const projectCwd = resolveProjectDirectory(options.cwd);
        const context = await prepareProjectContext(projectCwd);
        const config = await loadConfig();
        await initializeDatabase();

        try {
          const project = getProjectByHash(context.projectHash);
          if (!project) {
            console.error('❌ No project found. Initialize with `klaude` first.');
            process.exitCode = 1;
            return;
          }

          // Parse options
          const timeoutMs = parseInt(options.timeout, 10) * 1000;
          const intervalMs = parseInt(options.interval, 10);
          const waitForAny = options.any as boolean;

          // Resolve abbreviated session IDs to full IDs
          const resolvedSessionIds = sessionIds.map(id => resolveSessionId(id, project.id));

          // Validate session IDs exist and belong to this project
          const sessions = resolvedSessionIds.map((id) => {
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

          // Poll loop (silent waiting)
          while (true) {
            // Check timeout
            if (Date.now() - startTime > timeoutMs) {
              console.log(`Timeout after 9m30s. Current progress:`);
              console.log();

              // Display progress for all sessions
              for (let i = 0; i < resolvedSessionIds.length; i++) {
                const session = getSessionById(resolvedSessionIds[i]);
                if (session?.status) {
                  if (i > 0) {
                    console.log('\n---\n');
                  }
                  await displaySessionSummary(
                    resolvedSessionIds[i],
                    session.status,
                    context.projectHash,
                    context.projectRoot,
                    session.title,
                    config.wrapper?.projectsDir
                  );
                }
              }

              console.log();
              console.log(`Act on this progress, or else run klaude wait ${sessionIds.join(' ')} again.`);
              process.exitCode = 124; // Standard timeout exit code
              return;
            }

            // Query current status of all sessions
            const statuses = resolvedSessionIds.map((id) => {
              const session = getSessionById(id);
              return session ? session.status : null;
            });

            // Check completion conditions
            if (waitForAny) {
              // ANY: Return if at least one session is terminal
              const anyTerminal = statuses.some((status) => status && isTerminal(status));
              if (anyTerminal) {
                let printed = 0;
                for (let i = 0; i < resolvedSessionIds.length; i++) {
                  const status = statuses[i];
                  if (status && isTerminal(status)) {
                    if (printed > 0) {
                      console.log('\n---\n');
                    }
                    const session = getSessionById(resolvedSessionIds[i]);
                    await displaySessionSummary(
                      resolvedSessionIds[i],
                      status,
                      context.projectHash,
                      context.projectRoot,
                      session?.title ?? null,
                      config.wrapper?.projectsDir
                    );
                    printed++;
                  }
                }
                return;
              }
            } else {
              // ALL: Return if all sessions are terminal
              const allTerminal = statuses.every((status) => status && isTerminal(status));
              if (allTerminal) {
                for (let i = 0; i < resolvedSessionIds.length; i++) {
                  if (i > 0) {
                    console.log('\n---\n');
                  }
                  const session = getSessionById(resolvedSessionIds[i]);
                  await displaySessionSummary(
                    resolvedSessionIds[i],
                    statuses[i]!,
                    context.projectHash,
                    context.projectRoot,
                    session?.title ?? null,
                    config.wrapper?.projectsDir
                  );
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
