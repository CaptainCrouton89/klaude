import { promises as fsp } from 'node:fs';
import { Command, OptionValues } from 'commander';
import { prepareProjectContext } from '@/services/project-context.js';
import { loadConfig } from '@/services/config-loader.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import {
  tailSessionLog,
  printSessionSummary,
  printAssistantTranscript,
} from '@/services/session-log.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';
import { resolveProjectDirectory } from '@/utils/cli-helpers.js';

/**
 * Register the 'klaude read' command.
 * Reads a Klaude session log with various output modes.
 */
export function registerReadCommand(program: Command): void {
  program
    .command('read')
    .description('Read a Klaude session log')
    .argument('<sessionId>', 'Session id to read')
    .option('-t, --tail', 'Tail the log continuously')
    .option('-s, --summary', 'Print a brief summary instead of full log')
    .option('-v, --verbose', 'Verbose: print raw JSON events (default prints assistant text only)')
    .option('--instance <id>', 'Target instance id for live tailing')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionId: string, options: OptionValues) => {
      try {
        if (options.tail && options.summary) {
          throw new KlaudeError('Choose either --tail or --summary', 'E_INVALID_FLAGS');
        }

        const projectCwd = resolveProjectDirectory(options.cwd);
        const context = await prepareProjectContext(projectCwd);
        const config = await loadConfig();

        const logPath = getSessionLogPath(
          context.projectHash,
          sessionId,
          config.wrapper?.projectsDir,
        );

        try {
          if (options.tail) {
            await tailSessionLog(logPath, { untilExit: false, verbose: Boolean(options.verbose) });
          } else if (options.summary) {
            await printSessionSummary(logPath);
          } else {
            if (options.verbose) {
              const content = await fsp.readFile(logPath, 'utf-8');
              if (content.length === 0) {
                console.log('(log is empty)');
              } else {
                process.stdout.write(content);
                if (!content.endsWith('\n')) {
                  process.stdout.write('\n');
                }
              }
            } else {
              await printAssistantTranscript(logPath);
            }
          }
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              throw new KlaudeError(
                `Log file not found for session ${sessionId}`,
                'E_LOG_NOT_FOUND',
              );
            }
          }
          throw error;
        }
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
