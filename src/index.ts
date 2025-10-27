#!/usr/bin/env node

/**
 * Klaude CLI - Multi-agent session management wrapper
 * Entry point for the klaude command
 */

import { checkoutCommand, type CheckoutCommandData } from '@/commands/checkout.js';
import { startCommand } from '@/commands/start.js';
import { closeDatabase, initializeDatabase } from '@/db/database.js';
import { createSessionManager } from '@/db/session-manager.js';
import { createAgentManager } from '@/services/agent-manager.js';
import { loadConfig } from '@/services/config-loader.js';
import { createLogger } from '@/services/logger.js';
import { createMessageQueue } from '@/services/message-queue.js';
import { CLIContext } from '@/types/index.js';
import { safeExecute } from '@/utils/error-handler.js';
import { getKlaudeHome } from '@/utils/path-helper.js';
import { runWrapper } from '@/wrapper.js';
import { scheduleSessionSwitch } from '@/utils/session-switcher.js';
import chalk from 'chalk';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Initialize CLI context with all services
 */
async function initializeContext(): Promise<CLIContext> {
  // Initialize database
  await initializeDatabase();

  // Set up services
  const config = await loadConfig();
  const sessionManager = createSessionManager();
  const logger = createLogger();
  const agentManager = createAgentManager(sessionManager, logger, config);
  const messageQueue = createMessageQueue();

  return {
    config,
    sessionManager,
    agentManager,
    logger,
    messageQueue,
  };
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const exitCode = await runWrapper();
    process.exitCode = exitCode;
    return;
  }

  const program = new Command();

  program
    .name('klaude')
    .description('Multi-agent session management wrapper for Claude Code')
    .version('0.1.0');

  // Initialize context once for all commands
  const context = await initializeContext();

  /**
   * Start command - spawn a new agent
   * klaude start <agent_type> <prompt> [agent_count] [options]
   */
  program
    .command('start <agent_type> <prompt> [agent_count]')
    .description('Spawn an agent of the specified type with a prompt')
    .option('-c, --checkout', 'Check out to the agent immediately after starting')
    .option('-s, --share', 'Share current context (last X messages) with the new agent')
    .option('-d, --detach', 'Start without streaming output (daemonize)')
    .action(async (agentType: string, prompt: string, agentCount: string, options) => {
      await safeExecute(async () => {
        const count = agentCount ? parseInt(agentCount, 10) : 1;

        if (isNaN(count) || count < 1) {
          console.error(chalk.red('Error: agent_count must be a positive number'));
          process.exit(1);
        }

        // Validate and cast agent type - validation happens in startCommand
        const result = await startCommand(
          {
            agentType: agentType,
            prompt,
            count,
            checkout: options.checkout || false,
            share: options.share || false,
            detach: options.detach || false,
          } as Parameters<typeof startCommand>[0],
          context
        );

        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data && typeof result.data === 'object' && 'sessionIds' in result.data) {
            const sessionIds = (result.data as Record<string, unknown>).sessionIds;
            if (Array.isArray(sessionIds)) {
              console.log(chalk.gray(`Session IDs: ${sessionIds.join(', ')}`));
            }
          }
        } else {
          console.error(chalk.red('✗'), result.message);
          process.exit(1);
        }
      }, 'start command');
    });

  /**
   * Checkout command - switch to a different session
   * klaude checkout [session_id]
   */
  program
    .command('checkout [session_id]')
    .description('Switch to a different agent session')
    .action(async (sessionId: string | undefined) => {
      await safeExecute(async () => {
        const result = await checkoutCommand({ sessionId }, context);

        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data && typeof result.data === 'object') {
            const { session, switch: switchInfo } = result.data as CheckoutCommandData;
            if (session) {
              console.log(chalk.gray(`Agent: ${session.agentType}`));
              console.log(chalk.gray(`Status: ${session.status}`));
              console.log(chalk.gray(`Prompt: ${session.promptPreview}`));
            }
            if (switchInfo) {
              if (switchInfo.killError) {
                console.error(chalk.yellow('Warning:'), `Failed to signal Claude process: ${switchInfo.killError}`);
              } else if (!switchInfo.killAttempted) {
                console.log(chalk.yellow('Note:'), 'No active Claude process detected; resume manually if needed.');
              }
            }
          }
        } else {
          console.error(chalk.red('✗'), result.message);
          process.exit(1);
        }
      }, 'checkout command');
    });

  /**
   * Enter-agent command - seamless session switching with marker file and process handling
   * This is meant to be called from within Claude Code sessions
   * klaude enter-agent <agent_id>
   */
  program
    .command('enter-agent <agent_id>')
    .description('Seamlessly switch to a different agent session (called from within Claude)')
    .action(async (agentId: string) => {
      await safeExecute(async () => {
        // Get klaude home directory
        const klaudeHome = getKlaudeHome();

        // File paths for session switching mechanism
        const activePidsFile = path.join(klaudeHome, '.active-pids.json');

        try {
          // Read the active PIDs registry to find the target session
          let activePids: Record<string, Record<string, unknown>> = {};
          try {
            const content = await fs.readFile(activePidsFile, 'utf-8');
            activePids = JSON.parse(content);
          } catch (err) {
            // Registry might not exist yet, that's okay - continue with empty registry
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) {
              throw err;
            }
          }

          // Look up the agent in the registry
          if (!activePids[agentId]) {
            console.error(chalk.red('✗'), `Agent ${agentId} not found in registry`);
            process.exit(1);
          }

          const agentInfo = activePids[agentId];
          const targetSessionId = agentInfo.sessionId as string;
          const parentPidRaw = agentInfo.parentPid;
          const parentPid =
            typeof parentPidRaw === 'number'
              ? parentPidRaw
              : typeof parentPidRaw === 'string'
              ? parseInt(parentPidRaw, 10)
              : undefined;

          console.log(chalk.blue('↻'), `Switching to session ${targetSessionId}...`);

          const killPid = typeof parentPid === 'number' && Number.isFinite(parentPid) ? parentPid : undefined;
          const switchResult = await scheduleSessionSwitch(targetSessionId, {
            killPids: killPid !== undefined ? [killPid] : undefined,
          });

          if (switchResult.killError) {
            console.error(chalk.yellow('Warning:'), `Failed to signal Claude process: ${switchResult.killError}`);
          } else if (!switchResult.killAttempted) {
            console.log(chalk.yellow('Note:'), 'No active Claude process detected; resume manually if needed.');
          }

          // Exit cleanly so Claude sees a successful exit
          process.exit(0);
        } catch (error) {
          console.error(chalk.red('✗'), `Failed to switch session: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      }, 'enter-agent command');
    });

  try {
    // Parse command line arguments
    await program.parseAsync(process.argv);

    // If no command was provided, show help
    if (!process.argv.slice(2).length) {
      program.outputHelp();
    }
  } finally {
    try {
      context.messageQueue.shutdown();
    } catch (error) {
      console.error(chalk.yellow('Warning:'), `Failed to shutdown message queue: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Always close database on exit
    closeDatabase();
  }
}

// Run main with error handling
main().catch(error => {
  console.error(chalk.red('Fatal error:'), error instanceof Error ? error.message : String(error));
  process.exit(1);
});
