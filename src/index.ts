#!/usr/bin/env node

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Command, OptionValues } from 'commander';

import {
  handleSessionEndHook,
  handleSessionStartHook,
} from '@/hooks/session-hooks.js';
import type { ClaudeHookPayload } from '@/hooks/session-hooks.js';
import { listInstances } from '@/services/instance-registry.js';
import { prepareProjectContext } from '@/services/project-context.js';
import {
  getInstanceStatus,
  startAgentSession,
  requestCheckout,
  sendAgentMessage,
  interruptAgent,
} from '@/services/instance-client.js';
import { startWrapperInstance } from '@/services/wrapper-instance.js';
import { resolveInstanceForProject } from '@/services/instance-selection.js';
import {
  closeDatabase,
  getProjectByHash,
  initializeDatabase,
  listSessionsByProject,
} from '@/db/index.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import { loadConfig } from '@/services/config-loader.js';
import { KlaudeError, printError } from '@/utils/error-handler.js';

const program = new Command();

program
  .name('klaude')
  .description('Multi-agent wrapper for Claude Code sessions')
  .option('-C, --cwd <path>', 'Project directory override');

function resolveProjectDirectory(cwdOption?: string): string {
  return cwdOption ? path.resolve(cwdOption) : process.cwd();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }

  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    process.stdin.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.once('error', (error) => {
      reject(error);
    });
  });
}

program
  .command('hook')
  .description('Internal hook command invoked by Claude')
  .argument('<event>', 'Hook event (session-start | session-end)')
  .action(async (event: string) => {
    const startTime = Date.now();
    const logLine = (msg: string) => {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] [hook:${event}] ${msg}`;
      console.error(line);
      // Also write to persistent log
      fsp.appendFile('/tmp/klaude-hook.log', line + '\n').catch(() => {});
    };

    logLine(`HOOK STARTED - event=${event}, pid=${process.pid}`);
    logLine(`Environment: KLAUDE_PROJECT_HASH=${process.env.KLAUDE_PROJECT_HASH}, KLAUDE_SESSION_ID=${process.env.KLAUDE_SESSION_ID}, KLAUDE_INSTANCE_ID=${process.env.KLAUDE_INSTANCE_ID}`);
    logLine(`All env vars: ${JSON.stringify(process.env, null, 2)}`);

    try {
      logLine('Reading payload from stdin...');
      const rawPayload = await readStdin();
      logLine(`Received payload (${rawPayload.length} bytes): ${rawPayload.slice(0, 200)}`);

      if (!rawPayload) {
        throw new KlaudeError('Hook payload required on stdin', 'E_HOOK_PAYLOAD_MISSING');
      }

      let payload: unknown;
      try {
        logLine('Parsing JSON payload...');
        payload = JSON.parse(rawPayload);
        logLine(`Parsed payload: ${JSON.stringify(payload)}`);
      } catch (error) {
        throw new KlaudeError(
          `Invalid hook payload JSON: ${(error as Error).message}`,
          'E_HOOK_PAYLOAD_INVALID',
        );
      }

      logLine(`Dispatching to handler for event: ${event}`);
      switch (event) {
        case 'session-start':
          await handleSessionStartHook(payload as ClaudeHookPayload);
          break;
        case 'session-end':
          await handleSessionEndHook(payload as ClaudeHookPayload);
          break;
        default:
          throw new KlaudeError(
            `Unsupported hook event: ${event}`,
            'E_UNSUPPORTED_HOOK_EVENT',
          );
      }

      const elapsed = Date.now() - startTime;
      logLine(`HOOK SUCCEEDED - elapsed=${elapsed}ms`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const msg = error instanceof Error ? error.message : String(error);
      const code = error instanceof KlaudeError ? error.code : 'UNKNOWN';
      logLine(`HOOK FAILED - code=${code}, elapsed=${elapsed}ms, error=${msg}`);
      if (error instanceof Error && error.stack) {
        logLine(`Stack: ${error.stack}`);
      }
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('start')
  .description('Start a new agent session in the active wrapper instance')
  .argument('<agentType>', 'Agent type identifier (e.g., planner, programmer)')
  .argument('<prompt>', 'Prompt or task description for the agent')
  .argument('[agentCount]', 'Optional agent count for fan-out requests')
  .option('-c, --checkout', 'Request immediate checkout after start')
  .option('-s, --share', 'Share current context with the new agent')
  .option('-d, --detach', 'Do not attach to the agent stream')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (agentType, prompt, agentCountArg, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const agentCount =
        agentCountArg === undefined || agentCountArg === null
          ? undefined
          : Number(agentCountArg);
      if (agentCount !== undefined && Number.isNaN(agentCount)) {
        throw new KlaudeError('Agent count must be numeric', 'E_INVALID_AGENT_COUNT');
      }

      const payload = {
        agentType,
        prompt,
        agentCount,
        options: {
          checkout: Boolean(options.checkout),
          share: Boolean(options.share),
          detach: Boolean(options.detach),
        },
      };

      const response = await startAgentSession(instance.socketPath, payload);
      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      const result = response.result;
      console.log(`Started agent session ${result.sessionId} (${result.agentType})`);
      console.log(`Instance: ${result.instanceId}`);
      console.log(`Status: ${result.status}`);
      console.log(`Log: ${result.logPath}`);

      if (payload.options?.checkout) {
        const checkoutResponse = await requestCheckout(instance.socketPath, {
          sessionId: result.sessionId,
          waitSeconds: 5,
        });
        if (!checkoutResponse.ok) {
          throw new KlaudeError(checkoutResponse.error.message, checkoutResponse.error.code);
        }
        const checkoutResult = checkoutResponse.result;
        console.log(
          `Checkout activated for session ${checkoutResult.sessionId} (resume ${checkoutResult.claudeSessionId}).`,
        );
      }
      // Attach to live log stream unless explicitly detached or we just checked out
      if (!payload.options?.detach && !payload.options?.checkout) {
        await tailSessionLog(result.logPath, { untilExit: true, verbose: false });
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('instances')
  .description('List wrapper instances registered for this project')
  .option('-C, --cwd <path>', 'Project directory override')
  .option('--status', 'Query live status from active instances')
  .action(async (options) => {
    try {
      const projectCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      const context = await prepareProjectContext(projectCwd);
      const instances = await listInstances(context);

      if (instances.length === 0) {
        console.log('No wrapper instances registered for this project.');
        return;
      }

      console.log(`Project: ${context.projectRoot} (${context.projectHash})`);
      console.log(`Instances: ${instances.length}`);

      const includeStatus = Boolean(options.status);

      for (const entry of instances.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        const state = entry.endedAt ? `ended ${entry.endedAt}` : 'running';
        let statusInfo = '';

        if (includeStatus && !entry.endedAt) {
          try {
            const statusResponse = await getInstanceStatus(entry.socketPath);
            if (statusResponse.ok) {
              const result = statusResponse.result;
              statusInfo = `session=${result.rootSessionId} state=${result.sessionStatus} claudePid=${result.claudePid ?? 'n/a'}`;
            } else {
              statusInfo = `status_error=${statusResponse.error.code}`;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            statusInfo = `status_error=${message}`;
          }
        }

        const parts = [
          entry.instanceId,
          `pid=${entry.pid}`,
          `tty=${entry.tty ?? 'n/a'}`,
          state,
        ];
        if (statusInfo) {
          parts.push(statusInfo);
        }

        console.log(parts.join(' | '));
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('checkout')
  .description('Switch the Claude TUI to another Klaude session')
  .argument('[sessionId]', 'Target session id (defaults to parent)')
  .option('--wait <seconds>', 'Wait for hooks to deliver target session id', '5')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string | undefined, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const waitSeconds =
        options.wait === undefined || options.wait === null
          ? undefined
          : Number(options.wait);
      if (waitSeconds !== undefined && Number.isNaN(waitSeconds)) {
        throw new KlaudeError('Wait value must be numeric', 'E_INVALID_WAIT_VALUE');
      }

      const fromSessionId = process.env.KLAUDE_SESSION_ID;

      const response = await requestCheckout(instance.socketPath, {
        sessionId: sessionId ?? undefined,
        fromSessionId,
        waitSeconds,
      });

      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      const result = response.result as { sessionId: string; claudeSessionId: string };
      console.log(
        `Checkout activated for session ${result.sessionId} (resume ${result.claudeSessionId}).`,
      );
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('message')
  .description('Send a message to a running agent session')
  .argument('<sessionId>', 'Target session id')
  .argument('<prompt>', 'Message content')
  .option('-w, --wait <seconds>', 'Wait for response (default 5)', '5')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string, prompt: string, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const waitSeconds =
        options.wait === undefined || options.wait === null
          ? undefined
          : Number(options.wait);
      if (waitSeconds !== undefined && Number.isNaN(waitSeconds)) {
        throw new KlaudeError('Wait value must be numeric', 'E_INVALID_WAIT_VALUE');
      }

      const response = await sendAgentMessage(instance.socketPath, {
        sessionId,
        prompt,
        waitSeconds,
      });

      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      const result = response.result as { status?: string; messagesQueued?: number } | undefined;
      const status = result && typeof result.status === 'string' ? result.status : 'submitted';
      const queued = result && typeof result.messagesQueued === 'number' ? result.messagesQueued : 1;
      console.log(`Message ${status} (${queued} message${queued === 1 ? '' : 's'} queued).`);

      if (waitSeconds && waitSeconds > 0) {
        // Follow the session log briefly and stop on first assistant output
        const config = await loadConfig();
        const logPath = getSessionLogPath(
          context.projectHash,
          sessionId,
          config.wrapper?.projectsDir,
        );
        const found = await waitForFirstAssistantOutput(logPath, waitSeconds);
        if (!found) {
          console.log(`(no response within ${waitSeconds}s)`);
        }
      }
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('interrupt')
  .description('Send an interrupt signal to a running agent session')
  .argument('<sessionId>', 'Target session id')
  .option('--signal <signal>', 'POSIX signal to send (default SIGINT)')
  .option('--instance <id>', 'Target instance id')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string, options) => {
    try {
      const projectCwd = resolveProjectDirectory(options.cwd);
      const context = await prepareProjectContext(projectCwd);
      const instance = await resolveInstanceForProject(context, {
        instanceId: options.instance,
      });

      const response = await interruptAgent(instance.socketPath, {
        sessionId,
        signal: options.signal,
      });

      if (!response.ok) {
        throw new KlaudeError(response.error.message, response.error.code);
      }

      const result = response.result as { interrupted?: boolean; signal?: string } | undefined;
      const signal = result && typeof result.signal === 'string' ? result.signal : 'SIGINT';
      console.log(`Agent interrupted with ${signal}.`);
    } catch (error) {
      printError(error);
      process.exitCode = process.exitCode ?? 1;
    }
  });

program
  .command('sessions')
  .description('List sessions recorded for this project')
  .option('-v, --verbose', 'Show additional metadata for each session')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (options) => {
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

program
  .command('read')
  .description('Read a Klaude session log')
  .argument('<sessionId>', 'Session id to read')
  .option('-t, --tail', 'Tail the log continuously')
  .option('-s, --summary', 'Print a brief summary instead of full log')
  .option('-v, --verbose', 'Verbose: print raw JSON events (default prints assistant text only)')
  .option('--instance <id>', 'Target instance id for live tailing')
  .option('-C, --cwd <path>', 'Project directory override')
  .action(async (sessionId: string, options) => {
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

program.action(async (options: OptionValues) => {
  try {
    const projectCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
    await startWrapperInstance({ projectCwd });
  } catch (error) {
    printError(error);
    process.exitCode = process.exitCode ?? 1;
  }
});

program.parseAsync(process.argv).catch((error) => {
  printError(error);
  process.exitCode = process.exitCode ?? 1;
});

// ----------------------
// Helpers for read/tail
// ----------------------

async function tailSessionLog(
  logPath: string,
  options: { untilExit: boolean; verbose?: boolean },
): Promise<void> {
  // Print existing content first
  let position = 0;
  try {
    const content = await fsp.readFile(logPath, 'utf-8');
    if (content.length > 0) {
      process.stdout.write(content);
      if (!content.endsWith('\n')) process.stdout.write('\n');
      position = Buffer.byteLength(content, 'utf-8');
    }
  } catch {
    // if not exists yet, start at 0 and wait
    position = 0;
  }

  const { watch } = await import('node:fs');
  let closing = false;
  const stop = () => {
    if (!closing) {
      closing = true;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // To determine end-of-session, watch for specific events in appended lines
  const isTerminalEvent = (line: string): boolean => {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.kind === 'string') {
        const k = obj.kind as string;
        return (
          k === 'agent.runtime.done' ||
          k === 'agent.runtime.process.exited' ||
          k === 'wrapper.finalized' ||
          k === 'wrapper.claude.exited'
        );
      }
    } catch {}
    return false;
  };

  // State for pretty printing assistant text only
  const verbose = Boolean(options.verbose);
  let printedStream = false;

  const handleLine = (line: string): void => {
    if (verbose) {
      process.stdout.write(line + '\n');
      return;
    }
    try {
      const obj = JSON.parse(line) as { kind?: string; payload?: any };
      if (obj.kind === 'agent.runtime.message') {
        const mt = obj.payload?.messageType as string | undefined;
        const text = typeof obj.payload?.text === 'string' ? obj.payload.text : '';
        if (mt === 'stream_event') {
          if (text) {
            process.stdout.write(text);
            printedStream = true;
          }
          return;
        }
        if (mt === 'assistant') {
          if (!printedStream && text) {
            process.stdout.write(text + '\n');
          }
          return;
        }
      }
      if (obj.kind === 'agent.runtime.result') {
        if (printedStream) {
          process.stdout.write('\n');
          printedStream = false;
        }
        return;
      }
    } catch {
      // ignore parse errors in non-verbose mode
    }
  };

  const readChunk = async (): Promise<void> => {
    try {
      const fh = await (await import('node:fs/promises')).open(logPath, 'r');
      const stat = await fh.stat();
      if (stat.size > position) {
        const length = stat.size - position;
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, position);
        position = stat.size;
        fh.close().catch(() => {});
        const text = buffer.toString('utf-8');
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line) continue;
          handleLine(line);
          if (options.untilExit && isTerminalEvent(line)) {
            stop();
          }
        }
      } else {
        fh.close().catch(() => {});
      }
    } catch (err) {
      // ignore until file appears again
    }
  };

  await readChunk();

  const watcher = watch(logPath, { persistent: true });
  await new Promise<void>((resolve) => {
    watcher.on('change', async () => {
      if (closing) return;
      await readChunk();
      if (closing) {
        watcher.close();
        resolve();
      }
    });
    watcher.on('rename', async () => {
      // file rotated/recreated
      await readChunk();
      if (closing) {
        watcher.close();
        resolve();
      }
    });
    // Poll every 250ms in case change events are coalesced
    const timer = setInterval(async () => {
      if (closing) {
        clearInterval(timer);
        watcher.close();
        resolve();
        return;
      }
      await readChunk();
      if (closing) {
        clearInterval(timer);
        watcher.close();
        resolve();
      }
    }, 250).unref();
  });
}

async function printSessionSummary(logPath: string): Promise<void> {
  const content = await fsp.readFile(logPath, 'utf-8');
  if (!content.trim()) {
    console.log('(log is empty)');
    return;
  }
  const lines = content.split('\n').filter(Boolean);
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let agentType: string | null = null;
  let totalEvents = 0;
  let messages = 0;
  let results = 0;
  let errors = 0;
  let lastText: string | null = null;
  const resumeIds = new Set<string>();

  for (const line of lines) {
    totalEvents++;
    try {
      const obj = JSON.parse(line) as { timestamp?: string; kind?: string; payload?: any };
      if (obj.timestamp) {
        if (!createdAt) createdAt = obj.timestamp;
        updatedAt = obj.timestamp;
      }
      switch (obj.kind) {
        case 'agent.session.created':
          agentType = obj.payload?.agentType ?? agentType;
          break;
        case 'agent.runtime.message':
          messages++;
          if (typeof obj.payload?.text === 'string' && obj.payload.text.trim()) {
            lastText = obj.payload.text;
          }
          break;
        case 'agent.runtime.result':
          results++;
          if (typeof obj.payload?.result === 'string' && obj.payload.result.trim()) {
            lastText = obj.payload.result;
          }
          break;
        case 'agent.runtime.error':
          errors++;
          break;
        case 'agent.runtime.claude-session':
          if (typeof obj.payload?.sessionId === 'string') {
            resumeIds.add(obj.payload.sessionId);
          }
          break;
        case 'wrapper.checkout.resume_selected':
          if (typeof obj.payload?.selectedResumeId === 'string') {
            resumeIds.add(obj.payload.selectedResumeId);
          }
          break;
      }
    } catch {
      // ignore parse failures
    }
  }

  console.log(`agent: ${agentType ?? 'unknown'}`);
  console.log(`events: ${totalEvents}, messages: ${messages}, results: ${results}, errors: ${errors}`);
  if (createdAt) console.log(`created: ${createdAt}`);
  if (updatedAt) console.log(`updated: ${updatedAt}`);
  if (resumeIds.size > 0) console.log(`resume_ids: ${Array.from(resumeIds).join(', ')}`);
  if (lastText) console.log(`last_text: ${lastText}`);
}

async function printAssistantTranscript(logPath: string): Promise<void> {
  const content = await fsp.readFile(logPath, 'utf-8');
  if (!content.trim()) {
    console.log('(log is empty)');
    return;
  }
  const lines = content.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { kind?: string; payload?: any };
      if (obj.kind === 'agent.runtime.message') {
        const mt = obj.payload?.messageType as string | undefined;
        const text = typeof obj.payload?.text === 'string' ? obj.payload.text : '';
        if (mt === 'assistant' && text) {
          console.log(text);
        }
      }
    } catch {
      // ignore parse errors
    }
  }
}

async function waitForFirstAssistantOutput(logPath: string, waitSeconds: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  // Start from end of file
  let position = 0;
  try {
    const stat = await (await import('node:fs/promises')).stat(logPath);
    position = stat.size;
  } catch {}

  const { watch } = await import('node:fs');

  const isAssistantLine = (line: string): boolean => {
    try {
      const obj = JSON.parse(line) as { kind?: string; payload?: any };
      if (!obj || typeof obj !== 'object') return false;
      if (obj.kind === 'agent.runtime.message') {
        const t = obj.payload?.messageType;
        return t === 'assistant' || t === 'stream_event';
      }
      if (obj.kind === 'agent.runtime.result') return true;
    } catch {}
    return false;
  };

  const readChunk = async (): Promise<string[]> => {
    const chunks: string[] = [];
    try {
      const fh = await (await import('node:fs/promises')).open(logPath, 'r');
      const stat = await fh.stat();
      if (stat.size > position) {
        const length = stat.size - position;
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, position);
        position = stat.size;
        fh.close().catch(() => {});
        const text = buffer.toString('utf-8');
        for (const line of text.split('\n')) {
          if (line) chunks.push(line);
        }
      } else {
        fh.close().catch(() => {});
      }
    } catch {}
    return chunks;
  };

  // Quick pass in case something already landed
  for (const line of await readChunk()) {
    if (isAssistantLine(line)) {
      const obj = JSON.parse(line);
      if (typeof obj.payload?.text === 'string' && obj.payload.text) {
        console.log(obj.payload.text);
      }
      return true;
    }
  }

  const watcher = watch(logPath, { persistent: true });
  return await new Promise<boolean>((resolve) => {
    const check = async () => {
      if (Date.now() >= deadline) {
        watcher.close();
        resolve(false);
        return;
      }
      for (const line of await readChunk()) {
        if (isAssistantLine(line)) {
          try {
            const obj = JSON.parse(line);
            if (typeof obj.payload?.text === 'string' && obj.payload.text) {
              console.log(obj.payload.text);
            }
          } catch {}
          watcher.close();
          resolve(true);
          return;
        }
      }
    };
    watcher.on('change', check);
    watcher.on('rename', check);
    const timer = setInterval(check, 200).unref();
  });
}
