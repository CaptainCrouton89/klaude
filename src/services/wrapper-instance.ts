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
import {
  getInstanceSocketPath,
  getSessionLogPath,
} from '@/utils/path-helper.js';
import { KlaudeError } from '@/utils/error-handler.js';
import type { InstanceRequest, InstanceStatusPayload } from '@/types/instance-ipc.js';

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

    createEvent(
      'wrapper.start',
      project.id,
      rootSession.id,
      JSON.stringify({ instanceId }),
    );

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

    claudeProcess.once('spawn', () => {
      updateSessionStatus(rootSession.id, 'running');
      if (claudeProcess.pid) {
        updateSessionProcessPid(rootSession.id, claudeProcess.pid);
        const runtimeProcess = createRuntimeProcess(rootSession.id, claudeProcess.pid, 'claude', true);
        runtimeProcessId = runtimeProcess.id;
        currentClaudePid = claudeProcess.pid;
      }
      createEvent(
        'wrapper.claude.spawned',
        project.id,
        rootSession.id,
        JSON.stringify({ pid: claudeProcess.pid }),
      );
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

    process.exitCode = exitResult.code ?? (exitResult.signal ? 1 : 0);
  } catch (error) {
    await finalize('failed', null);
    createEvent(
      'wrapper.claude.error',
      project.id,
      rootSession.id,
      JSON.stringify({ message: (error as Error).message }),
    );
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
