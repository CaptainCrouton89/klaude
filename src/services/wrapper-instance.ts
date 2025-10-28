import net from 'node:net';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { WriteStream } from 'node:tty';

import { loadConfig } from '@/services/config-loader.js';
import { prepareProjectContext } from '@/services/project-context.js';
import {
  registerInstance,
  markInstanceEnded as markRegistryInstanceEnded,
} from '@/services/instance-registry.js';
import {
  initializeDatabase,
  closeDatabase,
  createProject,
  getProjectByHash,
  createInstance,
  markInstanceEnded,
  createSession,
  updateSessionStatus,
  updateSessionProcessPid,
  markSessionEnded,
  createRuntimeProcess,
  markRuntimeExited,
  createEvent,
  getSessionById,
} from '@/db/index.js';
import { generateULID } from '@/utils/ulid.js';
import { getInstanceSocketPath, getSessionLogPath } from '@/utils/path-helper.js';
import { KlaudeError } from '@/utils/error-handler.js';
import { appendSessionEvent } from '@/utils/logger.js';
import type {
  InstanceRequest,
  InstanceStatusPayload,
  StartAgentRequestPayload,
  StartAgentResponsePayload,
} from '@/types/instance-ipc.js';
import { VALID_AGENT_TYPES } from '@/config/constants.js';

interface WrapperStartOptions {
  projectCwd?: string;
}

interface ClaudeExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function detectTtyPath(): string | null {
  const streams = [process.stdout, process.stderr] as WriteStream[];
  for (const stream of streams) {
    if (stream.isTTY) {
      const ttyStream = stream as WriteStream & { path?: unknown };
      if (typeof ttyStream.path === 'string' && ttyStream.path.length > 0) {
        return ttyStream.path;
      }
    }
  }
  return null;
}

async function ensureSocketClean(socketPath: string): Promise<void> {
  try {
    await fsp.unlink(socketPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
    }
    throw error;
  }
}

async function ensureLogFile(logPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  try {
    await fsp.access(logPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await fsp.writeFile(logPath, '', 'utf-8');
        return;
      }
    }
    throw error;
  }
}

type InstanceRequestHandler = (request: InstanceRequest) => Promise<unknown>;

function writeSocketResponse(socket: net.Socket, payload: unknown): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function handleSocketConnection(socket: net.Socket, handler: InstanceRequestHandler): void {
  socket.setEncoding('utf8');
  let buffer = '';
  let responded = false;

  const respond = (payload: unknown): void => {
    if (responded) {
      return;
    }
    responded = true;
    writeSocketResponse(socket, payload);
    socket.end();
  };

  const handleMessage = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return;
    }

    let request: InstanceRequest;
    try {
      request = JSON.parse(trimmed) as InstanceRequest;
    } catch {
      respond({
        ok: false,
        error: {
          code: 'E_INVALID_JSON',
          message: 'Invalid JSON payload',
        },
      });
      return;
    }

    void (async () => {
      try {
        const result = await handler(request);
        respond({
          ok: true,
          result,
        });
      } catch (error) {
        if (error instanceof KlaudeError) {
          respond({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        respond({
          ok: false,
          error: {
            code: 'E_INTERNAL',
            message,
          },
        });
      }
    })();
  };

  socket.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const message = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleMessage(message);
      newlineIndex = buffer.indexOf('\n');
    }
  });

  socket.on('end', () => {
    if (buffer.length > 0) {
      handleMessage(buffer);
      buffer = '';
    }
  });

  socket.on('error', (error) => {
    console.error(`Instance socket connection error: ${error.message}`);
  });
}

async function startInstanceServer(
  socketPath: string,
  handler: InstanceRequestHandler,
): Promise<net.Server> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleSocketConnection(socket, handler);
    });

    const handleError = (error: Error) => {
      server.close(() => {
        reject(error);
      });
    };

    server.once('error', handleError);

    server.listen(socketPath, () => {
      server.off('error', handleError);
      server.on('error', (err) => {
        console.error(`Instance socket error (${socketPath}): ${err.message}`);
      });
      resolve(server);
    });
  });
}

async function closeInstanceServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function mapExitToStatus(result: ClaudeExitResult): 'done' | 'failed' | 'interrupted' {
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
    return 'interrupted';
  }
  if (result.code === 0) {
    return 'done';
  }
  return 'failed';
}

export async function startWrapperInstance(options: WrapperStartOptions = {}): Promise<void> {
  const cwd = options.projectCwd ?? process.cwd();

  const config = await loadConfig();
  const context = await prepareProjectContext(cwd);

  const db = await initializeDatabase();
  void db; // initialized for side effects

  let project = getProjectByHash(context.projectHash);
  if (!project) {
    project = createProject(context.projectRoot, context.projectHash);
  }

  const instanceId = generateULID();
  const socketPath = getInstanceSocketPath(
    context.projectHash,
    instanceId,
    config.wrapper?.socketDir,
  );

  await ensureSocketClean(socketPath);

  const ttyPath = detectTtyPath();

  await registerInstance(context, {
    instanceId,
    pid: process.pid,
    tty: ttyPath,
    socketPath,
  });

  createInstance(instanceId, project.id, process.pid, ttyPath);

  const rootSession = createSession(project.id, 'tui', {
    instanceId,
    title: 'Claude TUI',
    metadataJson: JSON.stringify({ projectRoot: context.projectRoot }),
  });

  const logPath = getSessionLogPath(
    context.projectHash,
    rootSession.id,
    config.wrapper?.projectsDir,
  );
  await ensureLogFile(logPath);

  let server: net.Server | null = null;

  let runtimeProcessId: number | null = null;
  let currentClaudePid: number | null = null;
  let finalized = false;

  const normalizeAgentType = (agentType: string): string => agentType.trim().toLowerCase();

  const resolveAgentType = (agentType: string): string => {
    const normalized = normalizeAgentType(agentType);
    const match = VALID_AGENT_TYPES.find((candidate) => candidate.toLowerCase() === normalized);
    if (!match) {
      throw new KlaudeError(`Unknown agent type: ${agentType}`, 'E_AGENT_TYPE_INVALID');
    }
    return match;
  };

  const handleStartAgent = async (
    payload: StartAgentRequestPayload,
  ): Promise<StartAgentResponsePayload> => {
    if (!payload.agentType || payload.agentType.trim().length === 0) {
      throw new KlaudeError('Agent type is required', 'E_AGENT_TYPE_REQUIRED');
    }
    if (!payload.prompt || payload.prompt.trim().length === 0) {
      throw new KlaudeError('Prompt is required for agent start', 'E_PROMPT_REQUIRED');
    }

    const agentType = resolveAgentType(payload.agentType);
    const parentSessionId = payload.parentSessionId ?? rootSession.id;

    const parentSession = getSessionById(parentSessionId);
    if (!parentSession) {
      throw new KlaudeError(
        `Parent session ${parentSessionId} not found`,
        'E_SESSION_NOT_FOUND',
      );
    }
    if (parentSession.project_id !== project.id) {
      throw new KlaudeError(
        `Parent session ${parentSessionId} does not belong to this project`,
        'E_SESSION_PROJECT_MISMATCH',
      );
    }

    const metadata = {
      agentType,
      prompt: payload.prompt,
      requestedAt: new Date().toISOString(),
      instanceId,
      agentCount: payload.agentCount ?? null,
      options: payload.options ?? {},
    };

    const session = createSession(project.id, 'sdk', {
      parentId: parentSession.id,
      instanceId,
      title: `${agentType} agent`,
      prompt: payload.prompt,
      metadataJson: JSON.stringify(metadata),
    });

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      session.id,
      config.wrapper?.projectsDir,
    );
    await ensureLogFile(sessionLogPath);

    const eventPayload = {
      agentType,
      parentSessionId: parentSession.id,
      options: payload.options ?? {},
      agentCount: payload.agentCount ?? null,
    };

    createEvent(
      'agent.session.created',
      project.id,
      session.id,
      JSON.stringify(eventPayload),
    );

    await appendSessionEvent(sessionLogPath, 'agent.session.created', eventPayload);

    return {
      sessionId: session.id,
      status: session.status,
      logPath: sessionLogPath,
      agentType,
      prompt: session.prompt ?? payload.prompt,
      createdAt: session.created_at,
      instanceId,
    };
  };

  const finalize = async (
    status: 'done' | 'failed' | 'interrupted',
    exitInfo: ClaudeExitResult | null,
  ): Promise<void> => {
    if (finalized) {
      return;
    }
    finalized = true;

    updateSessionProcessPid(rootSession.id, null);
    markSessionEnded(rootSession.id, status);

    if (runtimeProcessId !== null && exitInfo) {
      markRuntimeExited(runtimeProcessId, exitInfo.code ?? 0);
    }

    currentClaudePid = null;

    await markRegistryInstanceEnded(context, instanceId, exitInfo?.code ?? null);
    markInstanceEnded(instanceId, exitInfo?.code ?? null);
  };

  try {
    const requestHandler: InstanceRequestHandler = async (request) => {
      switch (request.action) {
        case 'ping':
          return {
            pong: true,
            timestamp: new Date().toISOString(),
          };
        case 'status': {
          const session = getSessionById(rootSession.id);
          if (!session) {
            throw new KlaudeError(
              'Root session not found for wrapper instance',
              'E_SESSION_NOT_FOUND',
            );
          }

          const payload: InstanceStatusPayload = {
            instanceId,
            projectHash: context.projectHash,
            projectRoot: context.projectRoot,
            rootSessionId: rootSession.id,
            sessionStatus: session.status,
            claudePid: currentClaudePid,
            updatedAt: session.updated_at ?? session.created_at,
          };
          return payload;
        }
        case 'start-agent':
          return await handleStartAgent(request.payload);
        case 'checkout':
          throw new KlaudeError('Checkout is not implemented yet', 'E_CHECKOUT_UNAVAILABLE');
        case 'message':
          throw new KlaudeError('Messaging is not implemented yet', 'E_MESSAGE_UNAVAILABLE');
        case 'interrupt':
          throw new KlaudeError('Interrupt is not implemented yet', 'E_INTERRUPT_UNAVAILABLE');
        default:
          throw new KlaudeError(
            `Unsupported instance request: ${(request as { action?: string }).action ?? 'unknown'}`,
            'E_UNSUPPORTED_ACTION',
          );
      }
    };

    server = await startInstanceServer(socketPath, requestHandler);

    const claudeBinary = config.wrapper?.claudeBinary;
    if (!claudeBinary) {
      throw new KlaudeError(
        'Claude binary is not configured. Set wrapper.claudeBinary in ~/.klaude/config.yaml.',
        'E_CLAUDE_BINARY_MISSING',
      );
    }

    const startPayload = { instanceId };
    createEvent(
      'wrapper.start',
      project.id,
      rootSession.id,
      JSON.stringify(startPayload),
    );
    await appendSessionEvent(logPath, 'wrapper.start', startPayload);

    const env = {
      ...process.env,
      KLAUDE_PROJECT_HASH: context.projectHash,
      KLAUDE_INSTANCE_ID: instanceId,
      KLAUDE_SESSION_ID: rootSession.id,
    };

    const claudeProcess = spawn(claudeBinary, [], {
      cwd: context.projectRoot,
      env,
      stdio: 'inherit',
    });

    claudeProcess.once('spawn', async () => {
      updateSessionStatus(rootSession.id, 'running');
      if (claudeProcess.pid) {
        updateSessionProcessPid(rootSession.id, claudeProcess.pid);
        const runtimeProcess = createRuntimeProcess(rootSession.id, claudeProcess.pid, 'claude', true);
        runtimeProcessId = runtimeProcess.id;
        currentClaudePid = claudeProcess.pid;
      }
      const spawnPayload = { pid: claudeProcess.pid };
      createEvent(
        'wrapper.claude.spawned',
        project.id,
        rootSession.id,
        JSON.stringify(spawnPayload),
      );
      await appendSessionEvent(logPath, 'wrapper.claude.spawned', spawnPayload);
    });

    let exitResult: ClaudeExitResult | null = null;

    exitResult = await new Promise<ClaudeExitResult>((resolve, reject) => {
      claudeProcess.once('exit', (code, signal) => resolve({ code, signal }));
      claudeProcess.once('error', reject);
    });

    const sessionStatus = mapExitToStatus(exitResult);
    await finalize(sessionStatus, exitResult);

    createEvent(
      'wrapper.claude.exited',
      project.id,
      rootSession.id,
      JSON.stringify(exitResult),
    );
    await appendSessionEvent(logPath, 'wrapper.claude.exited', exitResult);

    process.exitCode = exitResult.code ?? (exitResult.signal ? 1 : 0);
  } catch (error) {
    await finalize('failed', null);
    const errorPayload = { message: (error as Error).message };
    createEvent(
      'wrapper.claude.error',
      project.id,
      rootSession.id,
      JSON.stringify(errorPayload),
    );
    await appendSessionEvent(logPath, 'wrapper.claude.error', errorPayload);
    process.exitCode = 1;
    throw error;
  } finally {
    if (server) {
      await closeInstanceServer(server);
    }
    await ensureSocketClean(socketPath);
    closeDatabase();
  }
}
