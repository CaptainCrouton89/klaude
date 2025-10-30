#!/usr/bin/env node

import path from 'node:path';

import type { Command as CommanderCommand, OptionValues } from 'commander';
import type { ClaudeCliFlags } from '@/types/index.js';

import { ensureCompatibleNode, logBootstrap } from '@/utils/bootstrap.js';


// Extract Claude CLI flags before Commander processes arguments
const separatorIndex = process.argv.indexOf('--');
let claudeCliFlags: string[] = [];
let cleanedArgv = process.argv;

if (separatorIndex >= 0) {
  claudeCliFlags = process.argv.slice(separatorIndex + 1);
  cleanedArgv = [...process.argv.slice(0, separatorIndex)];
}

void (async () => {
  await ensureCompatibleNode();
  const { Command } = await import('commander');
  logBootstrap(
    `bootstrap post-compat modules=${process.versions.modules} exec=${process.execPath} argv=${JSON.stringify(process.argv)}`,
  );

  const [
    { startWrapperInstance },
    { printError },
    { parseClaudeFlags },
    { registerHookCommand },
    { registerSetupHooksCommand },
    { registerStartCommand },
    { registerInstancesCommand },
    { registerCheckoutCommand },
    { registerEnterAgentCommand },
    { registerMessageCommand },
    { registerInterruptCommand },
    { registerSessionsCommand },
    { registerLogsCommand },
    { registerWaitCommand },
    { registerStatusCommand },
  ] = await Promise.all([
    import('@/services/wrapper-instance.js'),
    import('@/utils/error-handler.js'),
    import('@/utils/cli-helpers.js'),
    import('@/commands/hook.js'),
    import('@/commands/setup-hooks.js'),
    import('@/commands/start.js'),
    import('@/commands/instances.js'),
    import('@/commands/checkout.js'),
    import('@/commands/enter-agent.js'),
    import('@/commands/message.js'),
    import('@/commands/interrupt.js'),
    import('@/commands/sessions.js'),
    import('@/commands/logs.js'),
    import('@/commands/wait.js'),
    import('@/commands/status.js'),
  ]);

  const program = new Command();

  program
    .name('klaude')
    .description('Multi-agent wrapper for Claude Code sessions')
    .option('-C, --cwd <path>', 'Project directory override')
    .showHelpAfterError('(add --help for additional information)')
    .addHelpCommand(true);

  program.on('command:*', function (this: CommanderCommand) {
    const unknownCommand = this.args[0];
    if (unknownCommand && typeof unknownCommand === 'string') {
      console.error(`\n❌ Unknown command '${unknownCommand}'`);
      console.error(`💡 Run 'klaude --help' to see available commands\n`);
      process.exitCode = 1;
    }
  });

  program.exitOverride((err) => {
    if (!err.message) {
      throw err;
    }

    if (err.message === '(outputHelp)' || err.message === '(default)') {
      process.exit(err.exitCode ?? 0);
    }

    if (err.message.includes('too many arguments') || err.message.includes('not recognized')) {
      const match = err.message.match(/(?:too many arguments|not recognized)[\s:]*(\S+)?/);
      const arg = match && match[1] ? match[1] : 'unknown argument';
      console.error(`\n❌ Invalid command or too many arguments: '${arg}'`);
      console.error(`💡 Run 'klaude --help' to see available commands\n`);
      process.exit(1);
    }

    if (err.message.includes('missing required argument')) {
      console.error(`\n${err.message.split('\n')[0]}`);
      console.error(`💡 Run the command with '--help' to see required arguments\n`);
      process.exit(1);
    }

    throw err;
  });

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

  program.action(async (options: OptionValues) => {
    try {
      const projectCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      const cliFlags: ClaudeCliFlags | undefined = claudeCliFlags.length > 0
        ? parseClaudeFlags(claudeCliFlags)
        : undefined;

      await startWrapperInstance({ projectCwd, claudeCliFlags: cliFlags });
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

  await program.parseAsync(cleanedArgv);
})().catch(async (error) => {
  const { printError } = await import('@/utils/error-handler.js');
  printError(error);
  process.exitCode = process.exitCode ?? 1;
});
