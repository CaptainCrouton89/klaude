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
 * Register the 'klaude logs' command.
 * Reads a Klaude session log with various output modes.
 */
export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Read a Klaude session log')
    .argument('<sessionId>', 'Session id to read')
    .option('-f, --follow', 'Stream log continuously (like tail -f)')
    .option('-s, --summary', 'Print a brief summary instead of full log')
    .option('--raw', 'Show raw JSON events (default shows assistant text only)')
    .option('-n, --lines <number>', 'Limit output to N lines')
    .option('--tail <number>', 'Show last N lines (alias for -n)')
    .option('--head <number>', 'Show first N lines')
    .option('--instance <id>', 'Target instance id for live tailing')
    .option('-C, --cwd <path>', 'Project directory override')
    .action(async (sessionId: string, options: OptionValues) => {
      try {
        if (options.follow && options.summary) {
          throw new KlaudeError('Choose either --follow or --summary', 'E_INVALID_FLAGS');
        }

        // Validate line limit options
        const lineOptions = [options.tail, options.lines, options.head].filter(Boolean);
        if (lineOptions.length > 1) {
          throw new KlaudeError('Choose only one of --tail, --lines, or --head', 'E_INVALID_FLAGS');
        }

        // Parse line limit
        let lineLimit: { type: 'head' | 'tail'; count: number } | undefined;
        if (options.tail) {
          const count = parseInt(options.tail, 10);
          if (!Number.isInteger(count) || count < 0) {
            throw new KlaudeError('--tail must be a positive integer', 'E_INVALID_VALUE');
          }
          lineLimit = { type: 'tail', count };
        } else if (options.lines) {
          const count = parseInt(options.lines, 10);
          if (!Number.isInteger(count) || count < 0) {
            throw new KlaudeError('--lines must be a positive integer', 'E_INVALID_VALUE');
          }
          lineLimit = { type: 'tail', count }; // Default to tail behavior
        } else if (options.head) {
          const count = parseInt(options.head, 10);
          if (!Number.isInteger(count) || count < 0) {
            throw new KlaudeError('--head must be a positive integer', 'E_INVALID_VALUE');
          }
          lineLimit = { type: 'head', count };
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
          if (options.follow) {
            if (lineLimit) {
              console.warn('⚠️  Ignoring line limit options with --follow');
            }
            await tailSessionLog(logPath, { untilExit: false, raw: Boolean(options.raw) });
          } else if (options.summary) {
            if (lineLimit) {
              console.warn('⚠️  Ignoring line limit options with --summary');
            }
            await printSessionSummary(logPath);
          } else {
            if (options.raw) {
              const content = await fsp.readFile(logPath, 'utf-8');
              if (content.length === 0) {
                console.log('(log is empty)');
              } else {
                const lines = content.split('\n');
                const filteredLines = applyLineLimit(lines, lineLimit);
                const output = filteredLines.join('\n');
                process.stdout.write(output);
                if (!output.endsWith('\n')) {
                  process.stdout.write('\n');
                }
              }
            } else {
              const content = await fsp.readFile(logPath, 'utf-8');
              if (content.length === 0) {
                console.log('(log is empty)');
              } else {
                const lines = content.split('\n').filter(Boolean);
                const filteredLines = applyLineLimit(lines, lineLimit);
                for (const line of filteredLines) {
                  try {
                    const obj = JSON.parse(line);
                    if (obj.kind === 'agent.runtime.message') {
                      const payload = obj.payload as { messageType?: string; text?: string } | undefined;
                      const mt = payload?.messageType;
                      const text = typeof payload?.text === 'string' ? payload.text : '';
                      if (mt === 'assistant' && text) {
                        console.log(text);
                      }
                    }
                  } catch {
                    // ignore parse errors
                  }
                }
              }
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

/**
 * Apply line limit to an array of lines.
 * type 'head' returns first N lines, 'tail' returns last N lines.
 */
function applyLineLimit(
  lines: string[],
  limit: { type: 'head' | 'tail'; count: number } | undefined,
): string[] {
  if (!limit) {
    return lines;
  }

  if (limit.type === 'head') {
    return lines.slice(0, limit.count);
  } else {
    return lines.slice(Math.max(0, lines.length - limit.count));
  }
}
