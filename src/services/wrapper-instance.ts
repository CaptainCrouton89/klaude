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
} from '@/db/index.js';
import { generateULID } from '@/utils/ulid.js';
import {
  getInstanceSocketPath,
  getSessionLogPath,
} from '@/utils/path-helper.js';
import { KlaudeError } from '@/utils/error-handler.js';

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
    if ((stream as WriteStream).isTTY && typeof (stream as WriteStream).path === 'string') {
      return (stream as WriteStream).path;
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

async function startInstanceServer(socketPath: string): Promise<net.Server> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.write(JSON.stringify({ error: 'NOT_IMPLEMENTED' }));
      socket.end();
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

  const server = await startInstanceServer(socketPath);

  try {
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

    let runtimeProcessId: number | null = null;
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

      await markRegistryInstanceEnded(context, instanceId, exitInfo?.code ?? null);
      markInstanceEnded(instanceId, exitInfo?.code ?? null);
    };

    claudeProcess.once('spawn', () => {
      updateSessionStatus(rootSession.id, 'running');
      if (claudeProcess.pid) {
        updateSessionProcessPid(rootSession.id, claudeProcess.pid);
        const runtimeProcess = createRuntimeProcess(rootSession.id, claudeProcess.pid, 'claude', true);
        runtimeProcessId = runtimeProcess.id;
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
    await markRegistryInstanceEnded(context, instanceId, null);
    markInstanceEnded(instanceId, null);
    markSessionEnded(rootSession.id, 'failed');
    createEvent(
      'wrapper.claude.error',
      project.id,
      rootSession.id,
      JSON.stringify({ message: (error as Error).message }),
    );
    process.exitCode = 1;
    throw error;
  } finally {
    await closeInstanceServer(server);
    await ensureSocketClean(socketPath);
    closeDatabase();
  }
}
