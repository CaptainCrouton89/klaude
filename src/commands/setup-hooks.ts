import { Command } from 'commander';
import { setupHooks } from '@/setup-hooks.js';
import { printError } from '@/utils/error-handler.js';

/**
 * Register the 'klaude setup-hooks' command.
 * Installs Klaude hooks to ~/.claude/settings.json.
 */
export function registerSetupHooksCommand(program: Command): void {
  program
    .command('setup-hooks')
    .description('Install Klaude hooks to ~/.claude/settings.json')
    .action(async () => {
      try {
        setupHooks();
      } catch (error) {
        printError(error);
        process.exitCode = process.exitCode ?? 1;
      }
    });
}
