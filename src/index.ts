#!/usr/bin/env node

import path from 'node:path';
import { Command, OptionValues } from 'commander';

import type { ClaudeCliFlags } from '@/types/index.js';
import { startWrapperInstance } from '@/services/wrapper-instance.js';
import { printError } from '@/utils/error-handler.js';
import { parseClaudeFlags } from '@/utils/cli-helpers.js';

// Command registrations
import { registerHookCommand } from '@/commands/hook.js';
import { registerSetupHooksCommand } from '@/commands/setup-hooks.js';
import { registerStartCommand } from '@/commands/start.js';
import { registerInstancesCommand } from '@/commands/instances.js';
import { registerCheckoutCommand } from '@/commands/checkout.js';
import { registerEnterAgentCommand } from '@/commands/enter-agent.js';
import { registerMessageCommand } from '@/commands/message.js';
import { registerInterruptCommand } from '@/commands/interrupt.js';
import { registerSessionsCommand } from '@/commands/sessions.js';
import { registerLogsCommand } from '@/commands/logs.js';
import { registerWaitCommand } from '@/commands/wait.js';
import { registerStatusCommand } from '@/commands/status.js';

// Extract Claude CLI flags before Commander processes arguments
// Commander treats everything after -- as positional args, which causes issues
// So we extract them first and remove them from argv
const separatorIndex = process.argv.indexOf('--');
let claudeCliFlags: string[] = [];
let cleanedArgv = process.argv;

if (separatorIndex >= 0) {
  claudeCliFlags = process.argv.slice(separatorIndex + 1);
  cleanedArgv = [...process.argv.slice(0, separatorIndex)];
}

const program = new Command();

program
  .name('klaude')
  .description('Multi-agent wrapper for Claude Code sessions')
  .option('-C, --cwd <path>', 'Project directory override')
  .showHelpAfterError('(add --help for additional information)')
  .addHelpCommand(true);

// Handle unknown commands and errors
program.on('command:*', function (this: Command) {
  const unknownCommand = this.args[0];
  if (unknownCommand && typeof unknownCommand === 'string') {
    console.error(`\n❌ Unknown command '${unknownCommand}'`);
    console.error(`💡 Run 'klaude --help' to see available commands\n`);
    process.exitCode = 1;
  }
});

// Custom error handler for argument parsing errors
program.exitOverride((err) => {
  if (!err.message) {
    throw err;
  }

  // Suppress the "(outputHelp)" message that Commander uses internally
  if (err.message === '(outputHelp)' || err.message === '(default)') {
    process.exit(err.exitCode ?? 0);
  }

  // Handle "too many arguments" or "not recognized" errors
  if (err.message.includes('too many arguments') || err.message.includes('not recognized')) {
    const match = err.message.match(/(?:too many arguments|not recognized)[\s:]*(\S+)?/);
    let arg: string;
    if (match && match[1]) {
      arg = match[1];
    } else {
      arg = 'unknown argument';
    }
    console.error(`\n❌ Invalid command or too many arguments: '${arg}'`);
    console.error(`💡 Run 'klaude --help' to see available commands\n`);
    process.exit(1);
  }

  // Handle "missing required argument" errors
  if (err.message.includes('missing required argument')) {
    console.error(`\n${err.message.split('\n')[0]}`);
    console.error(`💡 Run the command with '--help' to see required arguments\n`);
    process.exit(1);
  }

  // Let other errors through
  throw err;
});

// Register all commands
registerHookCommand(program);
registerSetupHooksCommand(program);
registerStartCommand(program);
registerInstancesCommand(program);
registerCheckoutCommand(program);
registerEnterAgentCommand(program);
registerMessageCommand(program);
registerInterruptCommand(program);
registerSessionsCommand(program);
registerLogsCommand(program);
registerWaitCommand(program);
registerStatusCommand(program);

// Default action (no command = start wrapper instance)
program.action(async (options: OptionValues) => {
  try {
    const projectCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

    // Use the Claude CLI flags extracted before Commander processing
    const cliFlags: ClaudeCliFlags | undefined = claudeCliFlags.length > 0
      ? parseClaudeFlags(claudeCliFlags)
      : undefined;

    await startWrapperInstance({ projectCwd, claudeCliFlags: cliFlags });
  } catch (error) {
    printError(error);
    process.exitCode = process.exitCode ?? 1;
  }
});

// Use cleaned argv (without the -- and Claude flags)
program.parseAsync(cleanedArgv).catch((error) => {
  printError(error);
  process.exitCode = process.exitCode ?? 1;
});
