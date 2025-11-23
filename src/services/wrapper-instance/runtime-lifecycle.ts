/**
 * Runtime lifecycle management for wrapper instance
 *
 * Handles spawning, event processing, and exit handling for all runtime types:
 * - Claude Code runtime (via agent-runtime.ts)
 * - Codex runtime (OpenAI CLI)
 * - Cursor runtime (cursor-agent CLI)
 * - Gemini runtime (gemini CLI)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentUpdate,
  createClaudeSessionLink,
  createRuntimeProcess,
  getClaudeSessionLink,
  getSessionById,
  markRuntimeExited,
  markSessionEnded,
  updateSessionClaudeLink,
  updateSessionProcessPid,
  updateSessionStatus,
} from '@/db/index.js';
import type { AgentDefinition } from '@/services/agent-definitions.js';
import { parseCodexEvent, parseCursorEvent, parseGeminiEvent } from '@/services/gpt-event-parser.js';
import type { StartAgentRequestPayload } from '@/types/instance-ipc.js';
import { abbreviateSessionId } from '@/utils/cli-helpers.js';
import { KlaudeError } from '@/utils/error-handler.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import type { RecordSessionEvent } from './event-recorder.js';
import type { AgentRuntimeEvent, AgentRuntimeState, ClaudeExitResult } from './types.js';
import { debugLog } from './utils.js';

/**
 * Dependencies required by runtime lifecycle manager
 */
export interface RuntimeLifecycleDependencies {
  agentRuntimes: Map<string, AgentRuntimeState>;
  recordSessionEvent: RecordSessionEvent;
  config: {
    sdk?: {
      model?: string;
      reasoningEffort?: string;
      permissionMode?: string;
      fallbackModel?: string;
    };
  };
  context: {
    projectHash: string;
    projectRoot: string;
  };
  projectRecord: {
    id: number;
  };
  instanceId: string;
  rootSession: {
    id: string;
  };
  wrapperConfig: {
    projectsDir?: string;
    gpt?: {
      preferredRuntime?: 'codex' | 'cursor' | 'auto';
      codex?: {
        binaryPath?: string;
        startupRetries?: number;
        startupRetryDelayMs?: number;
        startupRetryJitterMs?: number;
      };
      cursor?: {
        binaryPath?: string;
        startupRetries?: number;
        startupRetryDelayMs?: number;
        startupRetryJitterMs?: number;
      };
      gemini?: {
        binaryPath?: string;
        startupRetries?: number;
        startupRetryDelayMs?: number;
        startupRetryJitterMs?: number;
      };
    };
    // Legacy cursor config (backward compat)
    cursor?: {
      startupRetries?: number;
      startupRetryDelayMs?: number;
      startupRetryJitterMs?: number;
    };
  };
  claudeBinary: string;
  agentRuntimeEntryPath: string;
}

/**
 * Runtime lifecycle manager interface
 */
export interface RuntimeLifecycleManager {
  startAgentRuntime: (
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    resumeClaudeSessionId?: string | null,
    agentDefinition?: AgentDefinition | null,
  ) => Promise<void>;
  startGptRuntime: (
    primaryRuntime: 'codex' | 'cursor',
    fallbackRuntime: 'codex' | 'cursor' | undefined,
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    agentDefinition?: AgentDefinition | null,
  ) => Promise<void>;
  startGeminiRuntime: (
    fallbackRuntime: 'cursor' | undefined,
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    agentDefinition?: AgentDefinition | null,
  ) => Promise<void>;
  stopRuntime: (sessionId: string) => void;
  handleRuntimeEvent: (
    sessionId: string,
    event: AgentRuntimeEvent,
    runtimeState: AgentRuntimeState,
  ) => Promise<void>;
  handleRuntimeExit: (
    sessionId: string,
    exitInfo: ClaudeExitResult,
    runtimeState: AgentRuntimeState,
    options?: { skipSessionFinalization?: boolean; eventExtras?: Record<string, unknown> },
  ) => Promise<void>;
}

/**
 * Maps exit code/signal to session status
 */
function mapExitToStatus(result: ClaudeExitResult): 'done' | 'failed' | 'interrupted' {
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
    return 'interrupted';
  }
  if (result.code === 0) {
    return 'done';
  }
  return 'failed';
}

/**
 * Extracts text content from Cursor event message
 */
function extractCursorText(event: Record<string, unknown>): string | null {
  const message = event.message;
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) {
          parts.push(text);
        }
      }
      if (parts.length > 0) {
        return parts.join('');
      }
    }
  }

  const delta = event.delta;
  if (delta && typeof delta === 'object') {
    const text = (delta as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) {
      return text;
    }
  }

  return null;
}

/**
 * Maps Cursor raw events to AgentRuntimeEvent format
 */
function mapCursorEvent(rawEvent: unknown): AgentRuntimeEvent[] {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return [];
  }
  const event = rawEvent as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  const subtype = typeof event.subtype === 'string' ? event.subtype : null;
  const events: AgentRuntimeEvent[] = [];

  switch (type) {
    case 'system': {
      const model = typeof event.model === 'string' ? event.model : null;
      const detail = model
        ? `cursor-agent system.${subtype ?? 'event'} (model=${model})`
        : `cursor-agent system.${subtype ?? 'event'}`;
      events.push({ type: 'log', level: 'info', message: detail });
      if (subtype === 'init') {
        events.push({
          type: 'status',
          status: 'running',
          detail: model ? `Cursor agent using ${model}` : 'Cursor agent ready',
        });
      }
      break;
    }
    case 'assistant':
    case 'assistant_partial': {
      const text = extractCursorText(event);
      const messageType = subtype ? `assistant.${subtype}` : 'assistant';
      events.push({
        type: 'message',
        messageType,
        payload: rawEvent,
        text,
      });
      break;
    }
    case 'tool_call':
    case 'tool_result': {
      const messageType = subtype ? `${type}.${subtype}` : type;
      events.push({
        type: 'message',
        messageType,
        payload: rawEvent,
      });
      break;
    }
    case 'result': {
      const stopReason = typeof event.stopReason === 'string' ? event.stopReason : null;
      events.push({
        type: 'result',
        result: rawEvent,
        stopReason,
      });
      break;
    }
    case 'error': {
      const errorMessage =
        typeof event.message === 'string' ? event.message : 'Cursor agent reported an error';
      events.push({
        type: 'error',
        message: errorMessage,
        stack: typeof event.stack === 'string' ? event.stack : undefined,
      });
      break;
    }
    default: {
      events.push({
        type: 'message',
        messageType: `cursor.${type}`,
        payload: rawEvent,
      });
    }
  }

  return events;
}

/**
 * Creates a runtime lifecycle manager with the provided dependencies
 */
export function createRuntimeLifecycleManager(
  deps: RuntimeLifecycleDependencies,
): RuntimeLifecycleManager {
  const {
    agentRuntimes,
    recordSessionEvent,
    config,
    context,
    instanceId,
    wrapperConfig,
    agentRuntimeEntryPath,
  } = deps;

  /**
   * Handle agent runtime events
   */
  async function handleRuntimeEvent(
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

        // Extract [UPDATE] messages and push to parent
        if (event.text && typeof event.text === 'string') {
          const updatePattern = /\[UPDATE\]\s*(.+)/;
          const match = event.text.match(updatePattern);
          if (match && match[1]) {
            const updateText = match[1].trim();
            const session = getSessionById(sessionId);
            if (session?.parent_id) {
              try {
                await createAgentUpdate(sessionId, session.parent_id, updateText);
                debugLog(`[update-recorded] sessionId=${sessionId}, parentId=${session.parent_id}`);
              } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                debugLog(`[update-record-failed] sessionId=${sessionId}, error=${errMsg}`);
                // Non-fatal - continue processing other events
              }
            }
          }
        }
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

  /**
   * Handle agent runtime exit
   */
  async function handleRuntimeExit(
    sessionId: string,
    exitInfo: ClaudeExitResult,
    runtimeState: AgentRuntimeState,
    options?: { skipSessionFinalization?: boolean; eventExtras?: Record<string, unknown> },
  ): Promise<void> {
    updateSessionProcessPid(sessionId, null);

    if (runtimeState.runtimeProcessId !== null) {
      markRuntimeExited(runtimeState.runtimeProcessId, exitInfo.code ?? 0);
    }

    const inferredStatus = mapExitToStatus(exitInfo);

    if (
      !options?.skipSessionFinalization &&
      (runtimeState.status === 'pending' || runtimeState.status === 'running')
    ) {
      updateSessionStatus(sessionId, inferredStatus);
      markSessionEnded(sessionId, inferredStatus);
      runtimeState.status = inferredStatus;
    }

    await recordSessionEvent(sessionId, 'agent.runtime.process.exited', {
      code: exitInfo.code,
      signal: exitInfo.signal ?? null,
      inferredStatus,
      ...(options?.eventExtras ?? {}),
    });
  }

  /**
   * Start Claude Code agent runtime process
   */
  async function startAgentRuntime(
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    resumeClaudeSessionId?: string | null,
    agentDefinition: AgentDefinition | null = null,
  ): Promise<void> {
    debugLog(`[runtime-start] sessionId=${session.id}, agentType=${agentType}`);

    try {
      await import('node:fs/promises').then((fsp) => fsp.access(agentRuntimeEntryPath));
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
    const fullSessionId = session.id;
    const shortSessionId = abbreviateSessionId(fullSessionId);

    const child = spawn(process.execPath, [agentRuntimeEntryPath], {
      cwd: context.projectRoot,
      env: {
        ...process.env,
        KLAUDE_PROJECT_HASH: context.projectHash,
        KLAUDE_INSTANCE_ID: instanceId,
        KLAUDE_SESSION_ID: fullSessionId,
        KLAUDE_SESSION_ID_SHORT: shortSessionId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const runtimeState: AgentRuntimeState = {
      sessionId: fullSessionId,
      process: child,
      runtimeProcessId: null,
      status: 'pending',
      logPath: sessionLogPath,
      detached: Boolean(payload.options?.detach),
      runtimeKind: 'claude',
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
        definitionName: agentDefinition?.name ?? null,
        definitionScope: agentDefinition?.scope ?? null,
        runtimeKind: runtimeState.runtimeKind,
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
            void handleRuntimeEvent(session.id, event, runtimeState);
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
      void handleRuntimeExit(session.id, exitInfo, runtimeState).finally(() => {
        agentRuntimes.delete(session.id);
      });
    });

    // Load available MCPs and parent's resolved MCPs
    const { loadAvailableMcps } = await import('../mcp-loader.js');
    const availableMcps = await loadAvailableMcps(context.projectRoot);

    let parentMcps: Record<string, unknown> | undefined;
    if (session.parent_id) {
      const parentSession = getSessionById(session.parent_id);
      if (parentSession?.metadata_json) {
        try {
          const parentMetadata = JSON.parse(parentSession.metadata_json);
          parentMcps = parentMetadata.resolvedMcps;
        } catch {
          // Parent metadata not parseable, continue without parent MCPs
        }
      }
    }

    const configuredModel = agentDefinition?.model ?? config.sdk?.model ?? null;
    const configuredReasoningEffort =
      agentDefinition?.reasoningEffort ?? config.sdk?.reasoningEffort ?? null;
    const runtimeInitPayload = {
      sessionId: session.id,
      agentType,
      prompt: payload.prompt,
      outputStyle: agentDefinition?.instructions ?? undefined,
      options: payload.options ?? {},
      resumeClaudeSessionId: resumeClaudeSessionId ?? undefined,
      metadata: {
        projectHash: context.projectHash,
        instanceId,
        parentSessionId: session.parent_id ?? null,
        agentCount: payload.agentCount ?? null,
        projectRoot: context.projectRoot,
        agentDefinitionName: agentDefinition?.name ?? null,
        agentDefinitionSource: agentDefinition?.sourcePath ?? null,
        agentDefinitionScope: agentDefinition?.scope ?? null,
      },
      sdk: {
        model: configuredModel,
        permissionMode: config.sdk?.permissionMode ?? null,
        fallbackModel: config.sdk?.fallbackModel ?? null,
        pathToClaudeCodeExecutable: deps.claudeBinary,
        reasoningEffort: configuredReasoningEffort,
      },
      availableMcps,
      parentMcps,
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

  /**
   * Start GPT agent process (Codex or Cursor)
   */
  async function startGptRuntime(
    primaryRuntime: 'codex' | 'cursor',
    fallbackRuntime: 'codex' | 'cursor' | undefined,
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    agentDefinition: AgentDefinition | null = null,
  ): Promise<void> {
    debugLog(
      `[gpt-runtime-start] sessionId=${session.id}, agentType=${agentType}, primary=${primaryRuntime}, fallback=${fallbackRuntime ?? 'none'}`,
    );

    try {
      await launchGptRuntime(primaryRuntime, session, agentType, payload, agentDefinition);
    } catch (error) {
      if (fallbackRuntime && fallbackRuntime !== primaryRuntime) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(
          `[gpt-runtime-fallback] sessionId=${session.id}, primary=${primaryRuntime} failed (${errorMsg}), trying fallback=${fallbackRuntime}`,
        );
        await launchGptRuntime(fallbackRuntime, session, agentType, payload, agentDefinition);
      } else {
        throw error;
      }
    }
  }

  /**
   * Launch a specific GPT runtime (Codex or Cursor)
   */
  async function launchGptRuntime(
    runtime: 'codex' | 'cursor',
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    agentDefinition: AgentDefinition | null = null,
  ): Promise<void> {
    debugLog(`[${runtime}-runtime-launch] sessionId=${session.id}, agentType=${agentType}`);

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      session.id,
      wrapperConfig.projectsDir,
    );

    const sdkPermissionMode = config.sdk?.permissionMode ?? 'bypassPermissions';

    // Determine binary path and arguments based on runtime
    const gptConfig = wrapperConfig.gpt ?? {};
    const runtimeConfig = runtime === 'codex' ? gptConfig.codex : gptConfig.cursor;
    const legacyCursorConfig = wrapperConfig.cursor; // Backward compat

    const binaryPath =
      runtime === 'codex'
        ? runtimeConfig?.binaryPath ?? 'codex'
        : runtimeConfig?.binaryPath ?? 'cursor-agent';

    // Build CLI arguments based on runtime
    let runtimeArgs: string[];
    const fullPrompt = agentDefinition?.instructions
      ? `${agentDefinition.instructions}\n\n---\n\n${payload.prompt}`
      : payload.prompt;

    if (runtime === 'codex') {
      // Codex: codex exec --json [--dangerously-bypass-approvals-and-sandbox] [--model MODEL] PROMPT
      runtimeArgs = ['exec', '--json'];
      if (sdkPermissionMode === 'bypassPermissions') {
        runtimeArgs.push('--dangerously-bypass-approvals-and-sandbox');
      }
      const modelOverride = agentDefinition?.model;
      if (modelOverride && modelOverride.trim().length > 0) {
        runtimeArgs.push('--model', modelOverride);
      }
      // TODO: Verify Codex CLI flag for reasoning effort (may not be supported)
      const reasoningEffortOverride = agentDefinition?.reasoningEffort;
      if (reasoningEffortOverride) {
        // Placeholder - verify actual flag name with Codex documentation
        // runtimeArgs.push('--reasoning-effort', reasoningEffortOverride);
      }
      runtimeArgs.push(fullPrompt);
    } else {
      // Cursor: cursor-agent -p --output-format stream-json [--force] [--model MODEL] -- PROMPT
      runtimeArgs = ['-p', '--output-format', 'stream-json'];
      if (sdkPermissionMode === 'bypassPermissions') {
        runtimeArgs.push('--force');
      }
      const modelOverride = agentDefinition?.model;
      if (modelOverride && modelOverride.trim().length > 0) {
        runtimeArgs.push('--model', modelOverride);
      }
      // TODO: Verify Cursor CLI flag for reasoning effort (may not be supported)
      const reasoningEffortOverride = agentDefinition?.reasoningEffort;
      if (reasoningEffortOverride) {
        // Placeholder - verify actual flag name with Cursor documentation
        // runtimeArgs.push('--reasoning-effort', reasoningEffortOverride);
      }
      runtimeArgs.push('--', fullPrompt);
    }

    const fullSessionId = session.id;
    const shortSessionId = abbreviateSessionId(fullSessionId);

    // Get retry configuration for this runtime (with backward compat)
    const maxStartupAttempts = Math.max(
      1,
      runtimeConfig?.startupRetries ?? legacyCursorConfig?.startupRetries ?? 3,
    );
    const retryDelayMs = Math.max(
      0,
      runtimeConfig?.startupRetryDelayMs ?? legacyCursorConfig?.startupRetryDelayMs ?? 400,
    );
    const retryJitterMs = Math.max(
      0,
      runtimeConfig?.startupRetryJitterMs ?? legacyCursorConfig?.startupRetryJitterMs ?? 200,
    );

    const runtimeState: AgentRuntimeState = {
      sessionId: session.id,
      process: null as unknown as ChildProcess,
      runtimeProcessId: null,
      status: 'pending',
      logPath: sessionLogPath,
      detached: Boolean(payload.options?.detach),
      runtimeKind: runtime,
      cursorMeta: {
        attempts: 0,
        maxAttempts: maxStartupAttempts,
        pendingRetryTimer: null,
        cancelled: false,
        awaitingRetry: false,
      },
    };

    agentRuntimes.set(session.id, runtimeState);
    debugLog(`[${runtime}-runtime-tracked] sessionId=${session.id}`);

    return new Promise<void>((resolve, reject) => {
      // Flag to prevent duplicate resolve/reject calls
      let settled = false;

      const safeResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const safeReject = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const forwardRuntimeEvent = (event: AgentRuntimeEvent): void => {
        void handleRuntimeEvent(session.id, event, runtimeState);
      };

      const computeRetryDelay = (nextAttempt: number): number => {
        const multiplier = Math.max(1, nextAttempt - 1);
        const jitter = retryJitterMs > 0 ? Math.floor(Math.random() * retryJitterMs) : 0;
        return retryDelayMs * multiplier + jitter;
      };

      const emitStartupStatus = (attempt: number): void => {
        const runtimeLabel = runtime === 'codex' ? 'codex' : 'cursor-agent';
        const detail =
          attempt === 1
            ? `Launching ${runtimeLabel} runtime`
            : `Restarting ${runtimeLabel} runtime (attempt ${attempt}/${maxStartupAttempts})`;
        forwardRuntimeEvent({
          type: 'status',
          status: 'starting',
          detail,
        });
        if (attempt > 1) {
          forwardRuntimeEvent({
            type: 'log',
            level: 'info',
            message: `${runtimeLabel} restart attempt ${attempt}/${maxStartupAttempts}`,
          });
        }
      };

      const launchRuntimeAttempt = (attempt: number): void => {
        if (runtimeState.cursorMeta?.cancelled) {
          debugLog(`[${runtime}-runtime-cancelled] sessionId=${session.id}, attempt=${attempt}`);
          return;
        }

        runtimeState.cursorMeta!.attempts = attempt;
        runtimeState.cursorMeta!.pendingRetryTimer = null;
        runtimeState.cursorMeta!.awaitingRetry = false;

        emitStartupStatus(attempt);

        const child = spawn(binaryPath, runtimeArgs, {
          cwd: context.projectRoot,
          env: {
            ...process.env,
            KLAUDE_PROJECT_HASH: context.projectHash,
            KLAUDE_INSTANCE_ID: instanceId,
            KLAUDE_SESSION_ID: fullSessionId,
            KLAUDE_SESSION_ID_SHORT: shortSessionId,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        runtimeState.process = child;
        runtimeState.runtimeProcessId = null;

        let observedRuntimeOutput = false;

        child.once('spawn', async () => {
          if (!child.pid) {
            debugLog(`[${runtime}-runtime-spawn-no-pid] sessionId=${session.id}`);
            return;
          }
          debugLog(`[${runtime}-runtime-spawned] sessionId=${session.id}, pid=${child.pid}`);
          const runtimeProcess = createRuntimeProcess(session.id, child.pid, runtime, true);
          runtimeState.runtimeProcessId = runtimeProcess.id;
          updateSessionProcessPid(session.id, child.pid);
          updateSessionStatus(session.id, 'running');
          runtimeState.status = 'running';

          await recordSessionEvent(session.id, 'agent.runtime.spawned', {
            pid: child.pid,
            detached: runtimeState.detached,
            agentType,
            definitionName: agentDefinition?.name ?? null,
            definitionScope: agentDefinition?.scope ?? null,
            runtimeKind: runtimeState.runtimeKind,
            attempt,
          });
        });

        child.once('error', async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          debugLog(`[${runtime}-runtime-error] sessionId=${session.id}, error=${message}`);
          try {
            await recordSessionEvent(session.id, 'agent.runtime.process.error', {
              message,
              runtime,
            });
          } catch (recordError) {
            const recordMsg =
              recordError instanceof Error ? recordError.message : String(recordError);
            console.error(`[${runtime}-runtime-error-record-failed] ${recordMsg}`);
          }
          updateSessionStatus(session.id, 'failed');
          markSessionEnded(session.id, 'failed');
          runtimeState.status = 'failed';

          // Reject the promise to trigger fallback
          const errorObj = error instanceof Error ? error : new Error(message);
          safeReject(errorObj);
        });

        child.stdout?.setEncoding('utf8');
        let stdoutBuffer = '';
        child.stdout?.on('data', (chunk: string) => {
          observedRuntimeOutput = true;
          stdoutBuffer += chunk;
          let newlineIndex = stdoutBuffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = stdoutBuffer.slice(0, newlineIndex).trim();
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            if (line.length > 0) {
              try {
                const parsed = JSON.parse(line) as unknown;
                if (!parsed || typeof parsed !== 'object') {
                  continue;
                }
                const event = parsed as Record<string, unknown>;
                const type = typeof event.type === 'string' ? event.type : 'unknown';

                // Parse events based on runtime
                const events =
                  runtime === 'codex'
                    ? parseCodexEvent(event, type)
                    : parseCursorEvent(event, type);

                if (events.length === 0) {
                  void recordSessionEvent(session.id, 'agent.runtime.event.unknown', parsed);
                } else {
                  for (const evt of events) {
                    forwardRuntimeEvent(evt);
                  }
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void recordSessionEvent(session.id, 'agent.runtime.event.parse_error', {
                  line,
                  message,
                  source: runtime === 'codex' ? 'codex' : 'cursor-agent',
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
        let stderrBuffer = '';
        child.stderr?.on('data', (chunk: string) => {
          observedRuntimeOutput = true;
          stderrBuffer += chunk;
          let newlineIndex = stderrBuffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = stderrBuffer.slice(0, newlineIndex);
            stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
            const data = line.trim();
            if (data.length > 0) {
              void recordSessionEvent(session.id, 'agent.runtime.stderr', {
                data,
                runtime,
              });
            }
            newlineIndex = stderrBuffer.indexOf('\n');
          }
        });

        child.stderr?.on('end', () => {
          const remaining = stderrBuffer.trim();
          if (remaining.length > 0) {
            void recordSessionEvent(session.id, 'agent.runtime.stderr', {
              data: remaining,
              runtime,
            });
          }
          stderrBuffer = '';
        });

        child.once('exit', (code, signal) => {
          const exitInfo: ClaudeExitResult = { code, signal };
          const inferredStatus = mapExitToStatus(exitInfo);
          const wasStartupFailure = !observedRuntimeOutput;
          const hasAttemptsRemaining = attempt < maxStartupAttempts;
          const cancelled = runtimeState.cursorMeta?.cancelled ?? false;
          const shouldRetry = wasStartupFailure && hasAttemptsRemaining && !cancelled;

          void (async () => {
            await handleRuntimeExit(session.id, exitInfo, runtimeState, {
              skipSessionFinalization: shouldRetry,
              eventExtras: { attempt },
            });

            if (shouldRetry) {
              const nextAttempt = attempt + 1;
              const delay = computeRetryDelay(nextAttempt);
              if (runtimeState.cursorMeta) {
                runtimeState.cursorMeta.awaitingRetry = true;
                runtimeState.cursorMeta.lastExitStatus = inferredStatus;
              }
              debugLog(
                `[${runtime}-runtime-retry] sessionId=${session.id}, nextAttempt=${nextAttempt}, delay=${delay}ms`,
              );
              if (runtimeState.cursorMeta) {
                runtimeState.cursorMeta.pendingRetryTimer = setTimeout(() => {
                  runtimeState.cursorMeta!.pendingRetryTimer = null;
                  launchRuntimeAttempt(nextAttempt);
                }, delay);
                const timer = runtimeState.cursorMeta.pendingRetryTimer;
                if (timer && typeof timer.unref === 'function') {
                  timer.unref();
                }
              } else {
                launchRuntimeAttempt(nextAttempt);
              }
              await recordSessionEvent(session.id, 'agent.runtime.retry', {
                runtime,
                attempt,
                nextAttempt,
                maxAttempts: maxStartupAttempts,
                delayMs: delay,
                reason: `${runtime}_startup_no_output`,
              });
            } else {
              // All retries exhausted - resolve or reject based on final status
              agentRuntimes.delete(session.id);
              if (inferredStatus === 'failed') {
                safeReject(
                  new Error(
                    `${runtime} runtime failed after ${attempt} attempt(s) (exit code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`,
                  ),
                );
              } else {
                // Success or completed status
                safeResolve();
              }
            }
          })().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(
              `[${runtime}-runtime-exit-handler-error] sessionId=${session.id}, error=${message}`,
            );
            agentRuntimes.delete(session.id);
            safeReject(error instanceof Error ? error : new Error(message));
          });
        });
      };

      launchRuntimeAttempt(1);
    });
  }

  /**
   * Start Gemini agent process
   */
  async function startGeminiRuntime(
    fallbackRuntime: 'cursor' | undefined,
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    agentDefinition: AgentDefinition | null = null,
  ): Promise<void> {
    debugLog(
      `[gemini-runtime-start] sessionId=${session.id}, agentType=${agentType}, fallback=${fallbackRuntime ?? 'none'}`,
    );

    try {
      await launchGeminiRuntime(session, agentType, payload, agentDefinition);
    } catch (error) {
      if (fallbackRuntime) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(
          `[gemini-runtime-fallback] sessionId=${session.id}, gemini failed (${errorMsg}), trying fallback=${fallbackRuntime}`,
        );
        await launchGptRuntime(fallbackRuntime, session, agentType, payload, agentDefinition);
      } else {
        throw error;
      }
    }
  }

  /**
   * Launch Gemini runtime
   */
  async function launchGeminiRuntime(
    session: ReturnType<typeof import('@/db/index.js').createSession>,
    agentType: string,
    payload: StartAgentRequestPayload,
    agentDefinition: AgentDefinition | null = null,
  ): Promise<void> {
    const runtime = 'gemini';
    debugLog(`[${runtime}-runtime-launch] sessionId=${session.id}, agentType=${agentType}`);

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      session.id,
      wrapperConfig.projectsDir,
    );

    // Determine binary path and model
    const gptConfig = wrapperConfig.gpt ?? {};
    const geminiConfig = gptConfig.gemini ?? {};
    const binaryPath = geminiConfig.binaryPath ?? 'gemini';

    // Get retry configuration for Gemini runtime
    const maxStartupAttempts = Math.max(1, geminiConfig?.startupRetries ?? 3);
    const retryDelayMs = Math.max(0, geminiConfig?.startupRetryDelayMs ?? 400);
    const retryJitterMs = Math.max(0, geminiConfig?.startupRetryJitterMs ?? 200);

    // Build CLI arguments based on Gemini CLI spec: [-m, model, --output-format, stream-json, --yolo, -p, prompt]
    let runtimeArgs: string[];

    // Write agent instructions to temp file for GEMINI_SYSTEM_MD
    let systemPromptPath: string | null = null;
    if (agentDefinition?.instructions) {
      systemPromptPath = path.join(os.tmpdir(), `klaude-gemini-system-${session.id}.md`);
      fs.writeFileSync(systemPromptPath, agentDefinition.instructions, 'utf8');
    }

    // Use only the user prompt (system prompt is passed via env var)
    const fullPrompt = payload.prompt;

    runtimeArgs = [];

    const modelOverride = agentDefinition?.model;
    if (modelOverride && modelOverride.trim().length > 0) {
      runtimeArgs.push('-m', modelOverride);
    }

    // TODO: Verify Gemini CLI flag for reasoning effort (may not be supported)
    const reasoningEffortOverride = agentDefinition?.reasoningEffort;
    if (reasoningEffortOverride) {
      // Placeholder - verify actual flag name with Gemini CLI documentation
      // runtimeArgs.push('--reasoning-effort', reasoningEffortOverride);
    }

    runtimeArgs.push('--output-format', 'stream-json', '--yolo', '-p', fullPrompt);

    const fullSessionId = session.id;
    const shortSessionId = abbreviateSessionId(fullSessionId);

    const runtimeState: AgentRuntimeState = {
      sessionId: session.id,
      process: null as unknown as ChildProcess,
      runtimeProcessId: null,
      status: 'pending',
      logPath: sessionLogPath,
      detached: Boolean(payload.options?.detach),
      runtimeKind: runtime,
      cursorMeta: {
        attempts: 0,
        maxAttempts: maxStartupAttempts,
        pendingRetryTimer: null,
        cancelled: false,
        awaitingRetry: false,
      },
    };

    agentRuntimes.set(session.id, runtimeState);
    debugLog(`[${runtime}-runtime-tracked] sessionId=${session.id}`);

    const forwardRuntimeEvent = (event: AgentRuntimeEvent): void => {
      void handleRuntimeEvent(session.id, event, runtimeState);
    };

    const computeRetryDelay = (nextAttempt: number): number => {
      const multiplier = Math.max(1, nextAttempt - 1);
      const jitter = retryJitterMs > 0 ? Math.floor(Math.random() * retryJitterMs) : 0;
      return retryDelayMs * multiplier + jitter;
    };

    const launchRuntimeAttempt = (attempt: number): void => {
      if (runtimeState.cursorMeta?.cancelled) {
        debugLog(`[${runtime}-runtime-cancelled] sessionId=${session.id}, attempt=${attempt}`);
        return;
      }

      runtimeState.cursorMeta!.attempts = attempt;
      runtimeState.cursorMeta!.pendingRetryTimer = null;
      runtimeState.cursorMeta!.awaitingRetry = false;

      const detail =
        attempt === 1
          ? 'Launching gemini runtime'
          : `Restarting gemini runtime (attempt ${attempt}/${maxStartupAttempts})`;
      forwardRuntimeEvent({
        type: 'status',
        status: 'starting',
        detail,
      });
      if (attempt > 1) {
        forwardRuntimeEvent({
          type: 'log',
          level: 'info',
          message: `gemini restart attempt ${attempt}/${maxStartupAttempts}`,
        });
      }

      const child = spawn(binaryPath, runtimeArgs, {
        cwd: context.projectRoot,
        env: {
          ...process.env,
          KLAUDE_PROJECT_HASH: context.projectHash,
          KLAUDE_INSTANCE_ID: instanceId,
          KLAUDE_SESSION_ID: fullSessionId,
          KLAUDE_SESSION_ID_SHORT: shortSessionId,
          ...(systemPromptPath ? { GEMINI_SYSTEM_MD: systemPromptPath } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      runtimeState.process = child;
      runtimeState.runtimeProcessId = null;

      let observedRuntimeOutput = false;

      child.once('spawn', async () => {
        if (!child.pid) {
          debugLog(`[${runtime}-runtime-spawn-no-pid] sessionId=${session.id}`);
          return;
        }
        debugLog(`[${runtime}-runtime-spawned] sessionId=${session.id}, pid=${child.pid}`);
        const runtimeProcess = createRuntimeProcess(session.id, child.pid, runtime, true);
        runtimeState.runtimeProcessId = runtimeProcess.id;
        updateSessionProcessPid(session.id, child.pid);
        updateSessionStatus(session.id, 'running');
        runtimeState.status = 'running';

        await recordSessionEvent(session.id, 'agent.runtime.spawned', {
          pid: child.pid,
          detached: runtimeState.detached,
          agentType,
          definitionName: agentDefinition?.name ?? null,
          definitionScope: agentDefinition?.scope ?? null,
          runtimeKind: runtimeState.runtimeKind,
          attempt,
        });
      });

      child.once('error', async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        debugLog(`[${runtime}-runtime-error] sessionId=${session.id}, error=${message}`);
        try {
          await recordSessionEvent(session.id, 'agent.runtime.process.error', {
            message,
            runtime,
          });
        } catch (recordError) {
          const recordMsg =
            recordError instanceof Error ? recordError.message : String(recordError);
          console.error(`[${runtime}-runtime-error-record-failed] ${recordMsg}`);
        }
        updateSessionStatus(session.id, 'failed');
        markSessionEnded(session.id, 'failed');
        runtimeState.status = 'failed';
      });

      child.stdout?.setEncoding('utf8');
      let stdoutBuffer = '';
      child.stdout?.on('data', (chunk: string) => {
        observedRuntimeOutput = true;
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            try {
              const parsed = JSON.parse(line) as unknown;
              if (!parsed || typeof parsed !== 'object') {
                continue;
              }
              const event = parsed as Record<string, unknown>;
              const type = typeof event.type === 'string' ? event.type : 'unknown';

              // Parse events using Gemini parser
              const events = parseGeminiEvent(event, type);

              if (events.length === 0) {
                void recordSessionEvent(session.id, 'agent.runtime.event.unknown', parsed);
              } else {
                for (const evt of events) {
                  forwardRuntimeEvent(evt);
                }
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              void recordSessionEvent(session.id, 'agent.runtime.event.parse_error', {
                line,
                message,
                source: 'gemini-cli',
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
      let stderrBuffer = '';
      child.stderr?.on('data', (chunk: string) => {
        observedRuntimeOutput = true;
        stderrBuffer += chunk;
        let newlineIndex = stderrBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stderrBuffer.slice(0, newlineIndex);
          stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
          const data = line.trim();
          if (data.length > 0) {
            void recordSessionEvent(session.id, 'agent.runtime.stderr', {
              data,
              runtime,
            });
          }
          newlineIndex = stderrBuffer.indexOf('\n');
        }
      });

      child.stderr?.on('end', () => {
        const remaining = stderrBuffer.trim();
        if (remaining.length > 0) {
          void recordSessionEvent(session.id, 'agent.runtime.stderr', {
            data: remaining,
            runtime,
          });
        }
        stderrBuffer = '';
      });

      child.once('exit', (code, signal) => {
        const exitInfo: ClaudeExitResult = { code, signal };
        const inferredStatus = mapExitToStatus(exitInfo);
        const wasStartupFailure = !observedRuntimeOutput;
        const hasAttemptsRemaining = attempt < maxStartupAttempts;
        const cancelled = runtimeState.cursorMeta?.cancelled ?? false;
        const shouldRetry = wasStartupFailure && hasAttemptsRemaining && !cancelled;

        void (async () => {
          await handleRuntimeExit(session.id, exitInfo, runtimeState, {
            skipSessionFinalization: shouldRetry,
            eventExtras: { attempt },
          });

          if (shouldRetry) {
            const nextAttempt = attempt + 1;
            const delay = computeRetryDelay(nextAttempt);
            if (runtimeState.cursorMeta) {
              runtimeState.cursorMeta.awaitingRetry = true;
              runtimeState.cursorMeta.lastExitStatus = inferredStatus;
            }
            debugLog(
              `[${runtime}-runtime-retry] sessionId=${session.id}, nextAttempt=${nextAttempt}, delay=${delay}ms`,
            );
            if (runtimeState.cursorMeta) {
              runtimeState.cursorMeta.pendingRetryTimer = setTimeout(() => {
                runtimeState.cursorMeta!.pendingRetryTimer = null;
                launchRuntimeAttempt(nextAttempt);
              }, delay);
              const timer = runtimeState.cursorMeta.pendingRetryTimer;
              if (timer && typeof timer.unref === 'function') {
                timer.unref();
              }
            } else {
              launchRuntimeAttempt(nextAttempt);
            }
            await recordSessionEvent(session.id, 'agent.runtime.retry', {
              runtime,
              attempt,
              nextAttempt,
              maxAttempts: maxStartupAttempts,
              delayMs: delay,
              reason: `${runtime}_startup_no_output`,
            });
          } else {
            agentRuntimes.delete(session.id);
          }
        })().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `[${runtime}-runtime-exit-handler-error] sessionId=${session.id}, error=${message}`,
          );
          agentRuntimes.delete(session.id);
        });
      });
    };

    launchRuntimeAttempt(1);
  }

  /**
   * Stop a runtime process
   */
  function stopRuntime(sessionId: string): void {
    const runtimeState = agentRuntimes.get(sessionId);
    if (!runtimeState) {
      return;
    }

    // Cancel pending retry timers
    if (runtimeState.cursorMeta?.pendingRetryTimer) {
      clearTimeout(runtimeState.cursorMeta.pendingRetryTimer);
      runtimeState.cursorMeta.pendingRetryTimer = null;
    }
    if (runtimeState.cursorMeta) {
      runtimeState.cursorMeta.cancelled = true;
    }

    // Kill the process
    if (runtimeState.process && !runtimeState.process.killed) {
      try {
        runtimeState.process.kill('SIGTERM');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog(`[runtime-stop-error] sessionId=${sessionId}, error=${message}`);
      }
    }
  }

  return {
    startAgentRuntime,
    startGptRuntime,
    startGeminiRuntime,
    stopRuntime,
    handleRuntimeEvent,
    handleRuntimeExit,
  };
}
