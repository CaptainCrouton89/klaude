import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { WriteStream } from 'node:tty';
import { fileURLToPath } from 'node:url';

import { VALID_AGENT_TYPES } from '@/config/constants.js';
import {
  closeDatabase,
  createClaudeSessionLink,
  createEvent,
  createInstance,
  createProject,
  createRuntimeProcess,
  createSession,
  getClaudeSessionLink,
  listClaudeSessionLinks,
  getProjectByHash,
  getSessionById,
  initializeDatabase,
  markInstanceEnded,
  markRuntimeExited,
  markSessionEnded,
  updateSessionClaudeLink,
  updateSessionProcessPid,
  updateSessionStatus,
} from '@/db/index.js';
import { loadConfig } from '@/services/config-loader.js';
import {
  markInstanceEnded as markRegistryInstanceEnded,
  registerInstance,
} from '@/services/instance-registry.js';
import { prepareProjectContext } from '@/services/project-context.js';
import type {
  CheckoutRequestPayload,
  CheckoutResponsePayload,
  InstanceRequest,
  InstanceStatusPayload,
  InterruptRequestPayload,
  MessageRequestPayload,
  StartAgentRequestPayload,
  StartAgentResponsePayload,
} from '@/types/instance-ipc.js';
import { KlaudeError } from '@/utils/error-handler.js';
import { appendSessionEvent } from '@/utils/logger.js';
import { getInstanceSocketPath, getSessionLogPath } from '@/utils/path-helper.js';
import { generateULID } from '@/utils/ulid.js';

interface WrapperStartOptions {
  projectCwd?: string;
}

function debugLog(...args: unknown[]): void {
  if (process.env.KLAUDE_DEBUG === 'true') {
    console.error('[wrapper-instance]', ...args);
  }
}

function verboseLog(...args: unknown[]): void {
  if (process.env.KLAUDE_DEBUG_VERBOSE === 'true') {
    console.error('[wrapper-instance]', ...args);
  }
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
      debugLog('Invalid JSON received');
      respond({
        ok: false,
        error: {
          code: 'E_INVALID_JSON',
          message: 'Invalid JSON payload',
        },
      });
      return;
    }

    const action = typeof (request as { action?: string }).action === 'string'
      ? (request as { action?: string }).action
      : 'unknown';
    const startTime = Date.now();
    debugLog(`[handler-start] action=${action}`);

    void (async () => {
      try {
        const result = await handler(request);
        const elapsed = Date.now() - startTime;
        debugLog(`[handler-end] action=${action}, elapsed=${elapsed}ms, ok=true`);
        respond({
          ok: true,
          result,
        });
      } catch (error) {
        const elapsed = Date.now() - startTime;
        if (error instanceof KlaudeError) {
          debugLog(
            `[handler-end] action=${action}, elapsed=${elapsed}ms, error=${error.code}`,
          );
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
        debugLog(`[handler-error] action=${action}, elapsed=${elapsed}ms, message=${message}`);
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

type AgentRuntimeEvent =
  | { type: 'status'; status: 'starting' | 'running' | 'completed'; detail?: string }
  | { type: 'message'; messageType: string; payload: unknown; text?: string | null }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result?: unknown; stopReason?: string | null }
  | { type: 'claude-session'; sessionId: string; transcriptPath?: string | null }
  | { type: 'done'; status: 'done' | 'failed' | 'interrupted'; reason?: string };

interface AgentRuntimeState {
  sessionId: string;
  process: ChildProcess;
  runtimeProcessId: number | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
  logPath: string;
  detached: boolean;
}

export async function startWrapperInstance(options: WrapperStartOptions = {}): Promise<void> {
  const cwd = options.projectCwd ?? process.cwd();

  const config = await loadConfig();
  const context = await prepareProjectContext(cwd);

  const db = await initializeDatabase();
  void db;

  let project = getProjectByHash(context.projectHash);
  if (!project) {
    project = createProject(context.projectRoot, context.projectHash);
  }
  const projectRecord = project;

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

  createInstance(instanceId, projectRecord.id, process.pid, ttyPath);

  const rootSession = createSession(projectRecord.id, 'tui', {
    instanceId,
    title: 'Claude TUI',
    metadataJson: JSON.stringify({ projectRoot: context.projectRoot }),
  });

  const wrapperConfig = config.wrapper ?? {};
  const claudeBinaryConfig = wrapperConfig.claudeBinary;
  if (!claudeBinaryConfig) {
    throw new KlaudeError(
      'Claude binary is not configured. Set wrapper.claudeBinary in ~/.klaude/config.yaml.',
      'E_CLAUDE_BINARY_MISSING',
    );
  }
  const claudeBinary = claudeBinaryConfig;

  const rootLogPath = getSessionLogPath(
    context.projectHash,
    rootSession.id,
    wrapperConfig.projectsDir,
  );
  await ensureLogFile(rootLogPath);

  let server: net.Server | null = null;

  const agentRuntimeEntryPath = fileURLToPath(
    new URL('../runtime/agent-runtime.js', import.meta.url),
  );

  const agentRuntimes = new Map<string, AgentRuntimeState>();

  interface PendingSwitch {
    targetSessionId: string;
    targetClaudeSessionId: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  }

  const graceSeconds = Math.max(0, wrapperConfig.switch?.graceSeconds ?? 1);

  let finalized = false;

  const state = {
    currentSessionId: rootSession.id,
    currentClaudeProcess: null as ChildProcess | null,
    currentClaudePid: null as number | null,
    currentRuntimeProcessId: null as number | null,
    pendingSwitch: null as PendingSwitch | null,
    killTimer: null as NodeJS.Timeout | null,
  };

  let shutdownResolve: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });

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
    if (parentSession.project_id !== projectRecord.id) {
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

    const session = createSession(projectRecord.id, 'sdk', {
      parentId: parentSession.id,
      instanceId,
      title: `${agentType} agent`,
      prompt: payload.prompt,
      metadataJson: JSON.stringify(metadata),
    });

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      session.id,
      wrapperConfig.projectsDir,
    );
    await ensureLogFile(sessionLogPath);

    const eventPayload = {
      agentType,
      parentSessionId: parentSession.id,
      options: payload.options ?? {},
      agentCount: payload.agentCount ?? null,
    };

    try {
      await createEvent(
        'agent.session.created',
        projectRecord.id,
        session.id,
        JSON.stringify(eventPayload),
      );
      verboseLog(`[event-created] kind=agent.session.created, sessionId=${session.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to record agent.session.created event: ${message}`);
    }

    await appendSessionEvent(sessionLogPath, 'agent.session.created', eventPayload);

    let shareResumeId: string | null = null;
    if (payload.options?.share) {
      try {
        const parent = getSessionById(parentSession.id);
        if (parent) {
          // Prefer parent's active link, then latest link, else last_claude_session_id
          const links = listClaudeSessionLinks(parent.id);
          const active = links.find((l) => l.ended_at === null);
          if (active) {
            shareResumeId = active.claude_session_id;
          } else if (links.length > 0) {
            shareResumeId = links[0]!.claude_session_id;
          } else if (parent.last_claude_session_id) {
            shareResumeId = parent.last_claude_session_id;
          }
        }
      } catch {
        // ignore share selection failures
      }
    }

    await startAgentRuntimeProcess(session, agentType, payload, shareResumeId);

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

  async function recordSessionEvent(sessionId: string, kind: string, payload: unknown): Promise<void> {
    try {
      await createEvent(kind, projectRecord.id, sessionId, JSON.stringify(payload));
      verboseLog(`[event-recorded] kind=${kind}, sessionId=${sessionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[event-error] Failed to record event kind=${kind}: ${message}`);
      throw error;
    }

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      sessionId,
      wrapperConfig.projectsDir,
    );
    await ensureLogFile(sessionLogPath);
    await appendSessionEvent(sessionLogPath, kind, payload);
  }

  async function handleAgentRuntimeEvent(
    sessionId: string,
    event: AgentRuntimeEvent,
    runtimeState: AgentRuntimeState,
  ): Promise<void> {
    switch (event.type) {
      case 'status': {
        await recordSessionEvent(sessionId, 'agent.runtime.status', {
          status: event.status,
          detail: event.detail ?? null,
        });
        if (event.status === 'running') {
          updateSessionStatus(sessionId, 'running');
          runtimeState.status = 'running';
        }
        if (event.status === 'completed' && runtimeState.status === 'running') {
          updateSessionStatus(sessionId, 'done');
          markSessionEnded(sessionId, 'done');
          runtimeState.status = 'done';
        }
        break;
      }
      case 'message': {
        await recordSessionEvent(sessionId, 'agent.runtime.message', {
          messageType: event.messageType,
          payload: event.payload,
          text: event.text ?? null,
        });
        break;
      }
      case 'log': {
        await recordSessionEvent(sessionId, 'agent.runtime.log', {
          level: event.level,
          message: event.message,
        });
        break;
      }
      case 'result': {
        await recordSessionEvent(sessionId, 'agent.runtime.result', {
          result: event.result ?? null,
          stopReason: event.stopReason ?? null,
        });
        break;
      }
      case 'error': {
        await recordSessionEvent(sessionId, 'agent.runtime.error', {
          message: event.message,
          stack: event.stack ?? null,
        });
        updateSessionStatus(sessionId, 'failed');
        markSessionEnded(sessionId, 'failed');
        runtimeState.status = 'failed';
        break;
      }
      case 'done': {
        const finalStatus = event.status;
        await recordSessionEvent(sessionId, 'agent.runtime.done', {
          status: finalStatus,
          reason: event.reason ?? null,
        });
        updateSessionStatus(sessionId, finalStatus);
        markSessionEnded(sessionId, finalStatus);
        runtimeState.status = finalStatus;
        break;
      }
      case 'claude-session': {
        const link = getClaudeSessionLink(event.sessionId);
        if (!link) {
          try {
            createClaudeSessionLink(sessionId, event.sessionId, {
              transcriptPath: event.transcriptPath ?? null,
              source: 'sdk',
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await recordSessionEvent(sessionId, 'agent.runtime.link.error', {
              message,
            });
          }
        }
        updateSessionClaudeLink(sessionId, event.sessionId, event.transcriptPath ?? null);
        await recordSessionEvent(sessionId, 'agent.runtime.claude-session', {
          sessionId: event.sessionId,
          transcriptPath: event.transcriptPath ?? null,
        });
        break;
      }
      default: {
        await recordSessionEvent(sessionId, 'agent.runtime.event.unknown', event);
      }
    }
  }

  async function handleAgentRuntimeExit(
    sessionId: string,
    exitInfo: ClaudeExitResult,
    runtimeState: AgentRuntimeState,
  ): Promise<void> {
    updateSessionProcessPid(sessionId, null);

    if (runtimeState.runtimeProcessId !== null) {
      markRuntimeExited(runtimeState.runtimeProcessId, exitInfo.code ?? 0);
    }

    const inferredStatus = mapExitToStatus(exitInfo);

    if (runtimeState.status === 'pending' || runtimeState.status === 'running') {
      updateSessionStatus(sessionId, inferredStatus);
      markSessionEnded(sessionId, inferredStatus);
      runtimeState.status = inferredStatus;
    }

    await recordSessionEvent(sessionId, 'agent.runtime.process.exited', {
      code: exitInfo.code,
      signal: exitInfo.signal ?? null,
      inferredStatus,
    });
  }

  async function startAgentRuntimeProcess(
    session: ReturnType<typeof createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    resumeClaudeSessionId?: string | null,
  ): Promise<void> {
    debugLog(`[runtime-start] sessionId=${session.id}, agentType=${agentType}`);

    try {
      await fsp.access(agentRuntimeEntryPath);
    } catch {
      throw new KlaudeError(
        'Agent runtime entry point not found. Run `npm run build` to compile runtime scripts.',
        'E_AGENT_RUNTIME_ENTRY_MISSING',
      );
    }

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      session.id,
      wrapperConfig.projectsDir,
    );

    debugLog(`[runtime-spawn] entry=${agentRuntimeEntryPath}`);
    const child = spawn(process.execPath, [agentRuntimeEntryPath], {
      cwd: context.projectRoot,
      env: {
        ...process.env,
        KLAUDE_PROJECT_HASH: context.projectHash,
        KLAUDE_INSTANCE_ID: instanceId,
        KLAUDE_SESSION_ID: session.id,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const runtimeState: AgentRuntimeState = {
      sessionId: session.id,
      process: child,
      runtimeProcessId: null,
      status: 'pending',
      logPath: sessionLogPath,
      detached: Boolean(payload.options?.detach),
    };

    agentRuntimes.set(session.id, runtimeState);
    debugLog(`[runtime-tracked] sessionId=${session.id}`);

    child.once('spawn', async () => {
      if (!child.pid) {
        debugLog(`[runtime-spawn-no-pid] sessionId=${session.id}`);
        return;
      }
      debugLog(`[runtime-spawned] sessionId=${session.id}, pid=${child.pid}`);
      const runtimeProcess = createRuntimeProcess(session.id, child.pid, 'sdk', true);
      runtimeState.runtimeProcessId = runtimeProcess.id;
      updateSessionProcessPid(session.id, child.pid);
      updateSessionStatus(session.id, 'running');
      runtimeState.status = 'running';

      await recordSessionEvent(session.id, 'agent.runtime.spawned', {
        pid: child.pid,
        detached: runtimeState.detached,
        agentType,
      });
    });

    child.once('error', async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`[runtime-error] sessionId=${session.id}, error=${message}`);
      try {
        await recordSessionEvent(session.id, 'agent.runtime.process.error', { message });
      } catch (recordError) {
        const recordMsg = recordError instanceof Error ? recordError.message : String(recordError);
        console.error(`[runtime-error-record-failed] ${recordMsg}`);
      }
      updateSessionStatus(session.id, 'failed');
      markSessionEnded(session.id, 'failed');
      runtimeState.status = 'failed';
    });

    child.stdout?.setEncoding('utf8');
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            const event = JSON.parse(line) as AgentRuntimeEvent;
            void handleAgentRuntimeEvent(session.id, event, runtimeState);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void recordSessionEvent(session.id, 'agent.runtime.event.parse_error', {
              line,
              message,
            });
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stdout?.on('end', () => {
      const remaining = stdoutBuffer.trim();
      if (remaining.length > 0) {
        void recordSessionEvent(session.id, 'agent.runtime.stdout.trailing', {
          data: remaining,
        });
      }
      stdoutBuffer = '';
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const data = chunk.toString();
      void recordSessionEvent(session.id, 'agent.runtime.stderr', { data });
    });

    child.once('exit', (code, signal) => {
      const exitInfo: ClaudeExitResult = { code, signal };
      void handleAgentRuntimeExit(session.id, exitInfo, runtimeState).finally(() => {
        agentRuntimes.delete(session.id);
      });
    });

    const runtimeInitPayload = {
      sessionId: session.id,
      agentType,
      prompt: payload.prompt,
      options: payload.options ?? {},
      resumeClaudeSessionId: resumeClaudeSessionId ?? undefined,
      metadata: {
        projectHash: context.projectHash,
        instanceId,
        parentSessionId: session.parent_id ?? null,
        agentCount: payload.agentCount ?? null,
        projectRoot: context.projectRoot,
      },
      sdk: {
        model: config.sdk?.model ?? null,
        permissionMode: config.sdk?.permissionMode ?? null,
        fallbackModel: config.sdk?.fallbackModel ?? null,
      },
    };

    try {
      debugLog(`[runtime-init] sending init payload, sessionId=${session.id}`);
      child.stdin?.write(`${JSON.stringify(runtimeInitPayload)}\n`);
      // Keep stdin open for interactive `message` calls; do not end here.
      debugLog(`[runtime-init-sent] init payload sent, sessionId=${session.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`[runtime-stdin-error] sessionId=${session.id}, error=${message}`);
      try {
        await recordSessionEvent(session.id, 'agent.runtime.stdin.error', { message });
      } catch (recordError) {
        const recordMsg = recordError instanceof Error ? recordError.message : String(recordError);
        console.error(`[runtime-stdin-record-failed] ${recordMsg}`);
      }
    }
  }
  async function waitForClaudeSessionId(
    sessionId: string,
    waitSeconds: number,
  ): Promise<string | null> {
    const normalizedWait = Number.isFinite(waitSeconds) ? Math.max(0, waitSeconds) : 0;
    const deadline = Date.now() + normalizedWait * 1000;
    const pollDelayMs = 200;

    while (true) {
      const session = getSessionById(sessionId);
      if (!session) {
        throw new KlaudeError(`Session ${sessionId} not found`, 'E_SESSION_NOT_FOUND');
      }

      if (session.last_claude_session_id) {
        return session.last_claude_session_id;
      }

      if (normalizedWait === 0 || Date.now() >= deadline) {
        break;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollDelayMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });
    }

    return null;
  }

  async function waitForActiveClaudeSessionId(
    klaudeSessionId: string,
    waitSeconds: number,
  ): Promise<string | null> {
    const normalizedWait = Number.isFinite(waitSeconds) ? Math.max(0, waitSeconds) : 0;
    const deadline = Date.now() + normalizedWait * 1000;
    const pollDelayMs = 200;

    while (true) {
      try {
        const links = listClaudeSessionLinks(klaudeSessionId);
        const active = links.find((l) => l.ended_at === null);
        if (active) {
          return active.claude_session_id;
        }
      } catch {
        // ignore errors and continue waiting
      }

      if (normalizedWait === 0 || Date.now() >= deadline) {
        break;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollDelayMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });
    }

    return null;
  }

  function clearKillTimer(): void {
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }
  }

  function terminateCurrentClaudeProcess(): void {
    if (!state.currentClaudeProcess) {
      return;
    }

    const processRef = state.currentClaudeProcess;
    clearKillTimer();

    const graceMs = Math.floor(graceSeconds * 1000);
    if (graceMs > 0) {
      const timer = setTimeout(() => {
        if (!processRef.killed) {
          processRef.kill('SIGKILL');
        }
      }, graceMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      state.killTimer = timer;
    }

    processRef.kill('SIGTERM');
  }

  async function finalize(
    status: 'done' | 'failed' | 'interrupted',
    exitInfo: ClaudeExitResult | null,
  ): Promise<void> {
    if (finalized) {
      return;
    }
    finalized = true;

    clearKillTimer();
    state.pendingSwitch = null;
    state.currentClaudeProcess = null;
    state.currentRuntimeProcessId = null;
    state.currentClaudePid = null;

    updateSessionProcessPid(rootSession.id, null);
    markSessionEnded(rootSession.id, status);

    await markRegistryInstanceEnded(context, instanceId, exitInfo?.code ?? null);
    markInstanceEnded(instanceId, exitInfo?.code ?? null);

    try {
      await recordSessionEvent(rootSession.id, 'wrapper.finalized', {
        status,
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to record wrapper.finalized event: ${message}`);
    }

    if (shutdownResolve) {
      shutdownResolve();
      shutdownResolve = null;
    }

    if (exitInfo && exitInfo.code !== null) {
      process.exitCode = exitInfo.code;
    } else if (exitInfo && exitInfo.signal) {
      process.exitCode = 1;
    } else {
      process.exitCode = status === 'done' ? 0 : 1;
    }
  }

  async function launchClaudeForSession(
    sessionId: string,
    options: { resumeClaudeSessionId?: string; sourceSessionId?: string } = {},
  ): Promise<void> {
    debugLog(`[claude-launch] sessionId=${sessionId}, resume=${options.resumeClaudeSessionId ?? 'none'}`);

    const args: string[] = [];
    if (options.resumeClaudeSessionId) {
      args.push('--resume', options.resumeClaudeSessionId);
    }

    const env = {
      ...process.env,
      KLAUDE_PROJECT_HASH: context.projectHash,
      KLAUDE_INSTANCE_ID: instanceId,
      KLAUDE_SESSION_ID: sessionId,
    };

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      sessionId,
      wrapperConfig.projectsDir,
    );
    await ensureLogFile(sessionLogPath);

    state.currentSessionId = sessionId;

    let claudeProcess: ChildProcess;
    try {
      debugLog(`[claude-spawn] binary=${claudeBinary}, args=${args.join(' ')}`);
      claudeProcess = spawn(claudeBinary, args, {
        cwd: context.projectRoot,
        env,
        stdio: 'inherit',
      });
    } catch (error) {
      const message = (error as Error).message;
      debugLog(`[claude-spawn-error] ${message}`);
      throw new KlaudeError(
        `Failed to launch Claude binary: ${message}`,
        'E_CLAUDE_LAUNCH_FAILED',
      );
    }

    state.currentClaudeProcess = claudeProcess;
    state.currentClaudePid = null;

    claudeProcess.once('spawn', async () => {
      updateSessionStatus(sessionId, 'running');
      if (claudeProcess.pid) {
        updateSessionProcessPid(sessionId, claudeProcess.pid);
        state.currentClaudePid = claudeProcess.pid;
        const runtimeProcess = createRuntimeProcess(sessionId, claudeProcess.pid, 'claude', true);
        state.currentRuntimeProcessId = runtimeProcess.id;
      } else {
        state.currentRuntimeProcessId = null;
      }

      const payload = {
        pid: claudeProcess.pid,
        resumeSessionId: options.resumeClaudeSessionId ?? null,
        sourceSessionId: options.sourceSessionId ?? null,
      };
      try {
        await createEvent(
          'wrapper.claude.spawned',
          projectRecord.id,
          sessionId,
          JSON.stringify(payload),
        );
        verboseLog(`[event-created] kind=wrapper.claude.spawned, pid=${claudeProcess.pid}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to record wrapper.claude.spawned event: ${message}`);
      }
      void appendSessionEvent(sessionLogPath, 'wrapper.claude.spawned', payload);
    });

    claudeProcess.once('exit', (code, signal) => {
      void handleClaudeExit(sessionId, { code, signal });
    });

    claudeProcess.once('error', (error) => {
      void handleClaudeError(sessionId, error as Error);
    });

    // For fresh launches (not resuming), wait for the session-start hook to fire
    // and populate the Claude session ID. This ensures the root session (and any
    // subsequent subagents) always have a linked Claude session ID.
    if (!options.resumeClaudeSessionId) {
      const hookWaitSeconds = 10;
      debugLog(
        `[launch-hook-wait] Fresh launch, waiting up to ${hookWaitSeconds}s for session-start hook...`,
      );
      const hookStartTime = Date.now();

      const claudeSessionId = await waitForClaudeSessionId(sessionId, hookWaitSeconds);
      const hookElapsed = Date.now() - hookStartTime;
      debugLog(`[launch-hook-done] elapsed=${hookElapsed}ms, found=${claudeSessionId !== null}`);

      if (!claudeSessionId) {
        // Hook failed to fire - this is a critical error
        throw new KlaudeError(
          `Claude session hook did not fire within ${hookWaitSeconds}s. ` +
          `Ensure SessionStart hook is installed in ~/.claude/settings.json. ` +
          `Required config:\n` +
          `{\n  "hooks": {\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "klaude hook session-start" }] }],\n` +
          `    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "klaude hook session-end" }] }]\n  }\n}`,
          'E_HOOK_TIMEOUT',
        );
      }
    }
  }

  async function handleClaudeExit(sessionId: string, exitResult: ClaudeExitResult): Promise<void> {
    clearKillTimer();

    const runtimeProcessId = state.currentRuntimeProcessId;
    state.currentRuntimeProcessId = null;
    state.currentClaudeProcess = null;
    state.currentClaudePid = null;

    updateSessionProcessPid(sessionId, null);
    if (runtimeProcessId !== null) {
      markRuntimeExited(runtimeProcessId, exitResult.code ?? 0);
    }

    const switching = state.pendingSwitch !== null;
    const mappedStatus = mapExitToStatus(exitResult);

    if (switching) {
      updateSessionStatus(sessionId, 'active');
    } else {
      updateSessionStatus(sessionId, mappedStatus);
      if (mappedStatus === 'done' || mappedStatus === 'failed' || mappedStatus === 'interrupted') {
        markSessionEnded(sessionId, mappedStatus);
      }
    }

    const payload = {
      sessionId,
      code: exitResult.code,
      signal: exitResult.signal,
      switching,
    };
    await recordSessionEvent(sessionId, 'wrapper.claude.exited', payload);

    if (switching) {
      const switchInfo = state.pendingSwitch!;
      state.pendingSwitch = null;
      try {
        await launchClaudeForSession(switchInfo.targetSessionId, {
          resumeClaudeSessionId: switchInfo.targetClaudeSessionId,
          sourceSessionId: sessionId,
        });
        await recordSessionEvent(switchInfo.targetSessionId, 'wrapper.checkout.activated', {
          fromSessionId: sessionId,
          resumeSessionId: switchInfo.targetClaudeSessionId,
        });
        switchInfo.resolve();
      } catch (error) {
        switchInfo.reject(error);
        await finalize('failed', exitResult);
      }
      return;
    }

    await finalize(mappedStatus, exitResult);
  }

  async function handleClaudeError(sessionId: string, error: Error): Promise<void> {
    clearKillTimer();

    const runtimeProcessId = state.currentRuntimeProcessId;
    state.currentRuntimeProcessId = null;
    state.currentClaudeProcess = null;
    state.currentClaudePid = null;

    updateSessionProcessPid(sessionId, null);
    updateSessionStatus(sessionId, 'failed');
    markSessionEnded(sessionId, 'failed');

    if (runtimeProcessId !== null) {
      markRuntimeExited(runtimeProcessId, 1);
    }

    await recordSessionEvent(sessionId, 'wrapper.claude.error', {
      message: error.message,
    });

    if (state.pendingSwitch) {
      const pending = state.pendingSwitch;
      state.pendingSwitch = null;
      pending.reject(error);
    }

    await finalize('failed', null);
  }

  async function handleMessage(payload: MessageRequestPayload): Promise<{ status: string; messagesQueued: number }> {
    debugLog(`[message-request] sessionId=${payload.sessionId}, prompt="${payload.prompt.slice(0, 50)}..."`);

    let runtime = agentRuntimes.get(payload.sessionId);
    const waitSeconds = typeof payload.waitSeconds === 'number' && isFinite(payload.waitSeconds)
      ? Math.max(0, payload.waitSeconds)
      : 5;

    // If no runtime is active, attempt to start one resuming the prior Claude session
    if (!runtime) {
      const session = getSessionById(payload.sessionId);
      if (!session) {
        throw new KlaudeError(`Session ${payload.sessionId} not found`, 'E_SESSION_NOT_FOUND');
      }
      if (session.project_id !== projectRecord.id) {
        throw new KlaudeError(
          `Session ${payload.sessionId} does not belong to this project`,
          'E_SESSION_PROJECT_MISMATCH',
        );
      }

      // Derive the agent type label (stored in session metadata when created)
      let derivedAgentType = 'sdk';
      try {
        if (session.metadata_json) {
          const meta = JSON.parse(session.metadata_json) as { agentType?: string };
          if (meta && typeof meta.agentType === 'string' && meta.agentType.trim().length > 0) {
            derivedAgentType = meta.agentType;
          }
        }
      } catch {
        // ignore metadata parse errors; fallback to 'sdk'
      }

      // Prefer most recent active Claude session link, else latest link, else session.last_claude_session_id.
      // If none is yet known, wait briefly for hooks/SDK events to populate to avoid forking a new conversation.
      let resumeId: string | null = session.last_claude_session_id ?? null;
      let messageSelectionReason = 'unknown';
      try {
        const links = listClaudeSessionLinks(payload.sessionId);
        const active = links.find((l) => l.ended_at === null);
        if (active) {
          resumeId = active.claude_session_id;
          messageSelectionReason = 'active_link';
        } else if (links.length > 0) {
          resumeId = links[0]!.claude_session_id;
          messageSelectionReason = 'latest_link';
        } else {
          messageSelectionReason = 'cached';
        }
      } catch {
        // ignore link lookup failures
      }

      // If we still don't have a resume id, wait briefly for an active link or session record
      if (!resumeId && waitSeconds > 0) {
        const activeId = await waitForActiveClaudeSessionId(payload.sessionId, waitSeconds);
        if (activeId) {
          resumeId = activeId;
          messageSelectionReason = messageSelectionReason === 'unknown' ? 'waited_active' : `${messageSelectionReason}+waited_active`;
        }
      }

      if (!resumeId && waitSeconds > 0) {
        const lastId = await waitForClaudeSessionId(payload.sessionId, waitSeconds);
        if (lastId) {
          resumeId = lastId;
          messageSelectionReason = messageSelectionReason === 'unknown' ? 'waited_last' : `${messageSelectionReason}+waited_last`;
        }
      }

      // Launch a runtime for this existing session, using the incoming message as the initial prompt
      await startAgentRuntimeProcess(session as ReturnType<typeof createSession>, derivedAgentType, {
        agentType: derivedAgentType,
        prompt: payload.prompt,
        options: { detach: true },
      }, resumeId);

      runtime = agentRuntimes.get(payload.sessionId) ?? null as any;

      await recordSessionEvent(payload.sessionId, 'agent.message.runtime_started', {
        resumed: Boolean(resumeId),
        resumeClaudeSessionId: resumeId,
        selectionReason: messageSelectionReason,
      });

      // Since the initial prompt was passed to the runtime init, we do not need to write again here.
      return {
        status: 'queued',
        messagesQueued: 1,
      };
    }

    if (!runtime.process.stdin) {
      throw new KlaudeError(
        `Agent runtime for session ${payload.sessionId} has no stdin`,
        'E_AGENT_STDIN_UNAVAILABLE',
      );
    }

    const messagePayload = {
      type: 'message',
      prompt: payload.prompt,
    };

    try {
      debugLog(`[message-send] sessionId=${payload.sessionId}`);
      runtime.process.stdin.write(`${JSON.stringify(messagePayload)}\n`);

      await recordSessionEvent(payload.sessionId, 'agent.message.sent', {
        prompt: payload.prompt,
        waitSeconds: payload.waitSeconds ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KlaudeError(
        `Failed to send message to agent: ${message}`,
        'E_MESSAGE_SEND_FAILED',
      );
    }

    return {
      status: 'queued',
      messagesQueued: 1,
    };
  }

  async function handleInterrupt(payload: InterruptRequestPayload): Promise<{ interrupted: boolean; signal: string }> {
    debugLog(`[interrupt-request] sessionId=${payload.sessionId}, signal=${payload.signal ?? 'SIGINT'}`);

    const runtime = agentRuntimes.get(payload.sessionId);
    if (!runtime) {
      throw new KlaudeError(
        `No running agent for session ${payload.sessionId}`,
        'E_AGENT_NOT_RUNNING',
      );
    }

    if (!runtime.process.pid) {
      throw new KlaudeError(
        `Agent runtime process has no PID`,
        'E_AGENT_PID_UNAVAILABLE',
      );
    }

    const signal = payload.signal ?? 'SIGINT';
    try {
      debugLog(`[interrupt-send] sessionId=${payload.sessionId}, pid=${runtime.process.pid}, signal=${signal}`);
      process.kill(runtime.process.pid, signal as NodeJS.Signals);

      await recordSessionEvent(payload.sessionId, 'agent.interrupted', {
        signal,
        pid: runtime.process.pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KlaudeError(
        `Failed to interrupt agent: ${message}`,
        'E_INTERRUPT_FAILED',
      );
    }

    return {
      interrupted: true,
      signal,
    };
  }

  async function handleCheckout(
    payload: CheckoutRequestPayload,
  ): Promise<CheckoutResponsePayload> {
    const checkoutStart = Date.now();
    debugLog(`[checkout-start] timestamp=${checkoutStart}`);

    if (state.pendingSwitch) {
      throw new KlaudeError('A checkout is already in progress', 'E_CHECKOUT_IN_PROGRESS');
    }

    const waitSecondsRaw =
      typeof payload.waitSeconds === 'number'
        ? payload.waitSeconds
        : typeof payload.waitSeconds === 'string'
          ? Number(payload.waitSeconds)
          : 5; // Default to 5 seconds per PRD
    if (Number.isNaN(waitSecondsRaw)) {
      throw new KlaudeError('Wait value must be numeric', 'E_INVALID_WAIT_VALUE');
    }
    const waitSeconds = Math.max(0, waitSecondsRaw);
    debugLog(`[checkout-config] waitSeconds=${waitSeconds}`);

    const currentSessionId = payload.fromSessionId ?? state.currentSessionId;
    const currentSession = getSessionById(currentSessionId);
    if (!currentSession) {
      throw new KlaudeError(
        `Current session ${currentSessionId} not found`,
        'E_SESSION_NOT_FOUND',
      );
    }

    const requestedId =
      typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : null;

    const targetSessionId = requestedId !== null ? requestedId : currentSession.parent_id;
    if (!targetSessionId) {
      throw new KlaudeError(
        'Current session has no parent; specify a session id explicitly',
        'E_SWITCH_TARGET_MISSING',
      );
    }
    const targetDisplay = requestedId !== null ? `${requestedId} (explicit)` : `${targetSessionId} (parent)`;
    debugLog(`[checkout-target] ${targetDisplay}`);

    const targetSession = getSessionById(targetSessionId);
    if (!targetSession) {
      throw new KlaudeError(
        `Session ${targetSessionId} not found`,
        'E_SESSION_NOT_FOUND',
      );
    }
    if (targetSession.project_id !== projectRecord.id) {
      throw new KlaudeError(
        `Session ${targetSessionId} does not belong to this project`,
        'E_SESSION_PROJECT_MISMATCH',
      );
    }

    const claudeSessionStart = Date.now();
    // Prefer the most recent active Claude session link if present
    let claudeSessionId = targetSession.last_claude_session_id;
    let selectionReason: string = 'unknown';
    try {
      const links = listClaudeSessionLinks(targetSessionId);
      const active = links.find((l) => l.ended_at === null);
      if (active) {
        claudeSessionId = active.claude_session_id;
        debugLog(`[checkout-link] Using active link ${claudeSessionId}`);
        selectionReason = 'active_link';
      } else if (links.length > 0) {
        claudeSessionId = links[0]!.claude_session_id;
        debugLog(`[checkout-link] Using latest link ${claudeSessionId}`);
        selectionReason = 'latest_link';
      }
    } catch (err) {
      // If link lookup fails, fall back to last_claude_session_id and standard wait logic
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[checkout-link-error] ${msg}`);
    }
    if (!claudeSessionId) {
      // First, wait for an active link to appear (e.g., from a resume hook)
      debugLog(`[checkout-wait] Waiting up to ${waitSeconds}s for active link...`);
      claudeSessionId = await waitForActiveClaudeSessionId(targetSession.id, waitSeconds);
      if (claudeSessionId) {
        selectionReason = selectionReason === 'unknown' ? 'waited_active' : `${selectionReason}+waited_active`;
      }
      if (!claudeSessionId) {
        // Fallback to waiting for last_claude_session_id (SDK runtime will update this)
        debugLog(`[checkout-wait] Active link not found, waiting for last_claude_session_id...`);
        claudeSessionId = await waitForClaudeSessionId(targetSession.id, waitSeconds);
        if (claudeSessionId) {
          selectionReason = selectionReason === 'unknown' ? 'waited_last' : `${selectionReason}+waited_last`;
        }
      }
      const waitElapsed = Date.now() - claudeSessionStart;
      debugLog(`[checkout-wait-done] elapsed=${waitElapsed}ms, found=${claudeSessionId !== null}`);
    } else {
      debugLog(`[checkout-cached] Using cached Claude session ID`);
      if (waitSeconds > 0) {
        const activeId = await waitForActiveClaudeSessionId(targetSession.id, waitSeconds);
        if (activeId && activeId !== claudeSessionId) {
          debugLog(`[checkout-active] Found newer active link ${activeId}, superseding cached ${claudeSessionId}`);
          claudeSessionId = activeId;
          selectionReason = selectionReason === 'unknown' ? 'waited_active_supersede' : `${selectionReason}+waited_active_supersede`;
        } else if (selectionReason === 'unknown') {
          selectionReason = 'cached';
        }
      } else if (selectionReason === 'unknown') {
        selectionReason = 'cached';
      }
    }

    if (!claudeSessionId) {
      throw new KlaudeError(
        `Target session ${targetSessionId} does not have a Claude session id`,
        'E_SWITCH_TARGET_MISSING',
      );
    }

    // Record explicit resume selection for traceability
    await recordSessionEvent(targetSessionId, 'wrapper.checkout.resume_selected', {
      selectedResumeId: claudeSessionId,
      selectionReason,
      waitSeconds,
    });

    if (targetSessionId === currentSessionId && state.currentClaudeProcess) {
      // Already on target session; no action needed
      await recordSessionEvent(currentSessionId, 'wrapper.checkout.already_active', {
        targetSessionId,
      });
      return {
        sessionId: targetSessionId,
        claudeSessionId,
      };
    }

    await recordSessionEvent(currentSessionId, 'wrapper.checkout.requested', {
      targetSessionId,
      waitSeconds,
    });

    if (!state.currentClaudeProcess) {
      debugLog(`[checkout-launch] No current process, launching directly...`);
      const launchStart = Date.now();
      await launchClaudeForSession(targetSessionId, {
        resumeClaudeSessionId: claudeSessionId,
        sourceSessionId: currentSessionId,
      });
      const launchElapsed = Date.now() - launchStart;
      debugLog(`[checkout-launch-done] elapsed=${launchElapsed}ms`);

      const recordStart = Date.now();
      await recordSessionEvent(targetSessionId, 'wrapper.checkout.activated', {
        fromSessionId: currentSessionId,
        resumeSessionId: claudeSessionId,
      });
      const recordElapsed = Date.now() - recordStart;
      debugLog(`[checkout-record-done] elapsed=${recordElapsed}ms`);

      const totalElapsed = Date.now() - checkoutStart;
      debugLog(`[checkout-complete] totalElapsed=${totalElapsed}ms`);

      return {
        sessionId: targetSessionId,
        claudeSessionId,
      };
    }

    debugLog(`[checkout-terminate] Current process exists, initiating switch...`);
    const terminateStart = Date.now();

    return await new Promise<CheckoutResponsePayload>((resolve, reject) => {
      state.pendingSwitch = {
        targetSessionId,
        targetClaudeSessionId: claudeSessionId,
        resolve: () => {
          const totalElapsed = Date.now() - checkoutStart;
          debugLog(`[checkout-switched] totalElapsed=${totalElapsed}ms`);
          resolve({ sessionId: targetSessionId, claudeSessionId });
        },
        reject: (error: unknown) => {
          const totalElapsed = Date.now() - checkoutStart;
          debugLog(`[checkout-switch-failed] totalElapsed=${totalElapsed}ms, error=${String(error)}`);
          reject(error);
        },
      };

      try {
        terminateCurrentClaudeProcess();
        const terminateElapsed = Date.now() - terminateStart;
        debugLog(`[checkout-terminate-sent] elapsed=${terminateElapsed}ms`);
      } catch (error) {
        state.pendingSwitch = null;
        reject(error);
      }
    });
  }

  try {
    const requestHandler: InstanceRequestHandler = async (request) => {
      switch (request.action) {
        case 'ping':
          return {
            pong: true,
            timestamp: new Date().toISOString(),
          };
        case 'status': {
          const session = getSessionById(state.currentSessionId);
          if (!session) {
            throw new KlaudeError(
              'Active session not found for wrapper instance',
              'E_SESSION_NOT_FOUND',
            );
          }

          const payload: InstanceStatusPayload = {
            instanceId,
            projectHash: context.projectHash,
            projectRoot: context.projectRoot,
            rootSessionId: rootSession.id,
            sessionStatus: session.status,
            claudePid: state.currentClaudePid,
            updatedAt: session.updated_at ?? session.created_at,
          };
          return payload;
        }
        case 'start-agent':
          return await handleStartAgent(request.payload);
        case 'checkout':
          return await handleCheckout(request.payload);
        case 'message':
          return await handleMessage(request.payload);
        case 'interrupt':
          return await handleInterrupt(request.payload);
        default:
          throw new KlaudeError(
            `Unsupported instance request: ${(request as { action?: string }).action ?? 'unknown'}`,
            'E_UNSUPPORTED_ACTION',
          );
      }
    };

    server = await startInstanceServer(socketPath, requestHandler);

    await recordSessionEvent(rootSession.id, 'wrapper.start', { instanceId });

    await launchClaudeForSession(rootSession.id);

    await shutdownPromise;
  } catch (error) {
    if (!finalized) {
      await finalize('failed', null);
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await recordSessionEvent(rootSession.id, 'wrapper.claude.error', { message });
    } catch {
      // ignore logging failures on shutdown
    }
    throw error;
  } finally {
    if (server) {
      await closeInstanceServer(server);
    }
    await ensureSocketClean(socketPath);
    closeDatabase();
  }
}
