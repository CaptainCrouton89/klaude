/**
 * IPC request handlers for wrapper instance
 *
 * Handles all IPC requests from CLI commands including start-agent, message,
 * interrupt, checkout, status, and ping.
 */

import {
  calculateSessionDepth,
  createEvent,
  getSessionById,
  listClaudeSessionLinks,
  updateSessionStatus,
  markSessionEnded,
} from '@/db/index.js';
import type { AgentDefinition } from '@/services/agent-definitions.js';
import {
  listAvailableAgentTypes,
  loadAgentDefinition,
} from '@/services/agent-definitions.js';
import { loadConfig } from '@/services/config-loader.js';
import type { RuntimeSelector } from '@/services/runtime-selector.js';
import type { McpServerConfig, Project, KlaudeConfig } from '@/types/index.js';
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
import { getSessionLogPath } from '@/utils/path-helper.js';
import type { ProjectContext } from '@/services/project-context.js';
import type { RuntimeLifecycleManager } from './runtime-lifecycle.js';
import type { ClaudeTuiLifecycle } from './claude-tui-lifecycle.js';
import type { RecordSessionEvent } from './event-recorder.js';
import type {
  WrapperState,
  AgentRuntimeState,
  InstanceRequestHandler,
} from './types.js';
import { debugLog, verboseLog, ensureLogFile } from './utils.js';

/**
 * Dependencies required by IPC handlers
 */
export interface IpcHandlerDependencies {
  config: Awaited<ReturnType<typeof loadConfig>>;
  context: ProjectContext;
  projectRecord: Project;
  instanceId: string;
  rootSession: ReturnType<typeof import('@/db/index.js').createSession>;
  wrapperConfig: KlaudeConfig['wrapper'];
  state: WrapperState;
  agentRuntimes: Map<string, AgentRuntimeState>;
  runtimeLifecycleManager: RuntimeLifecycleManager;
  claudeTuiLifecycle: ClaudeTuiLifecycle;
  runtimeSelector: RuntimeSelector;
  recordSessionEvent: RecordSessionEvent;
  finalized: { value: boolean };
}

/**
 * Normalizes agent type to lowercase trimmed string
 */
function normalizeAgentType(agentType: string): string {
  return agentType.trim().toLowerCase();
}

/**
 * Ensures an agent runtime is stopped within the specified timeout
 *
 * @param sessionId - Session ID to stop
 * @param waitSeconds - Maximum seconds to wait for graceful shutdown
 * @param agentRuntimes - Map of active agent runtimes
 * @param recordSessionEvent - Event recording function
 * @returns True if runtime was stopped, false if no runtime was found
 */
async function ensureAgentRuntimeStopped(
  sessionId: string,
  waitSeconds: number,
  agentRuntimes: Map<string, AgentRuntimeState>,
  recordSessionEvent: RecordSessionEvent,
): Promise<boolean> {
  const runtime = agentRuntimes.get(sessionId);
  if (!runtime) {
    return false;
  }

  if (runtime.cursorMeta) {
    runtime.cursorMeta.cancelled = true;
    if (runtime.cursorMeta.pendingRetryTimer) {
      clearTimeout(runtime.cursorMeta.pendingRetryTimer);
      runtime.cursorMeta.pendingRetryTimer = null;
    }
    if (runtime.cursorMeta.awaitingRetry) {
      runtime.cursorMeta.awaitingRetry = false;
      const fallbackStatus = runtime.cursorMeta.lastExitStatus ?? 'failed';
      updateSessionStatus(sessionId, fallbackStatus);
      markSessionEnded(sessionId, fallbackStatus);
      runtime.status = fallbackStatus;
      agentRuntimes.delete(sessionId);
      await recordSessionEvent(sessionId, 'agent.runtime.retry.cancelled', {
        runtime: runtime.runtimeKind,
        status: fallbackStatus,
      });
      debugLog(
        `[runtime-stop] sessionId=${sessionId}, cancelled pending cursor restart (status=${fallbackStatus})`,
      );
      return true;
    }
  }

  const normalizedWait =
    Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 5;
  const stopStart = Date.now();

  debugLog(`[runtime-stop] sessionId=${sessionId}, signal=SIGTERM`);
  try {
    runtime.process.kill('SIGTERM');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[runtime-stop-error] sessionId=${sessionId}, message=${message}`);
  }

  const deadline = stopStart + normalizedWait * 1000;
  while (agentRuntimes.has(sessionId) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  if (!agentRuntimes.has(sessionId)) {
    const elapsed = Date.now() - stopStart;
    debugLog(`[runtime-stop-complete] sessionId=${sessionId}, elapsed=${elapsed}ms`);
    return true;
  }

  const remainingRuntime = agentRuntimes.get(sessionId);
  if (remainingRuntime) {
    debugLog(`[runtime-stop-force] sessionId=${sessionId}, signal=SIGKILL`);
    try {
      remainingRuntime.process.kill('SIGKILL');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`[runtime-stop-force-error] sessionId=${sessionId}, message=${message}`);
    }
  }

  const forceDeadline = Date.now() + 1000;
  while (agentRuntimes.has(sessionId) && Date.now() < forceDeadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  if (agentRuntimes.has(sessionId)) {
    debugLog(`[runtime-stop-timeout] sessionId=${sessionId}`);
    throw new KlaudeError(
      `Timed out waiting for agent runtime ${sessionId} to stop`,
      'E_AGENT_RUNTIME_TIMEOUT',
    );
  }

  const totalElapsed = Date.now() - stopStart;
  debugLog(`[runtime-stop-forced] sessionId=${sessionId}, elapsed=${totalElapsed}ms`);
  return true;
}

/**
 * Creates IPC handler functions bound to wrapper instance dependencies
 *
 * @param deps - Dependencies required by handlers
 * @returns Object containing all IPC handler functions
 */
export function createIpcHandlers(deps: IpcHandlerDependencies) {
  const {
    config,
    context,
    projectRecord,
    instanceId,
    rootSession,
    wrapperConfig,
    state,
    agentRuntimes,
    runtimeLifecycleManager,
    claudeTuiLifecycle,
    runtimeSelector,
    recordSessionEvent,
    finalized,
  } = deps;

  /**
   * Handles start-agent requests
   */
  const handleStartAgent = async (
    payload: StartAgentRequestPayload,
  ): Promise<StartAgentResponsePayload> => {
    if (!payload.agentType || payload.agentType.trim().length === 0) {
      throw new KlaudeError('Agent type is required', 'E_AGENT_TYPE_REQUIRED');
    }
    if (!payload.prompt || payload.prompt.trim().length === 0) {
      throw new KlaudeError('Prompt is required for agent start', 'E_PROMPT_REQUIRED');
    }

    const requestedAgentType = payload.agentType;
    const normalizedAgentType = normalizeAgentType(requestedAgentType);
    const agentDefinition = await loadAgentDefinition(requestedAgentType, {
      projectRoot: context.projectRoot,
    });

    // Allow general-purpose agent to have no definition (runs with user prompt as-is)
    if (!agentDefinition && normalizedAgentType !== 'general-purpose') {
      const availableTypes = await listAvailableAgentTypes({
        projectRoot: context.projectRoot,
      });
      const typesList = availableTypes.join(', ');
      throw new KlaudeError(
        `Unknown agent type: ${requestedAgentType}\n\nAvailable agent types: ${typesList}`,
        'E_AGENT_TYPE_INVALID',
      );
    }

    // Ensure agent has instructions
    if (!agentDefinition?.instructions || agentDefinition.instructions.trim().length === 0) {
      throw new KlaudeError(
        `Agent type ${requestedAgentType} has no instructions defined`,
        'E_AGENT_INSTRUCTIONS_MISSING',
      );
    }

    const agentType = agentDefinition?.type ?? normalizedAgentType;
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

    if (parentSession.id !== rootSession.id) {
      let parentMetadata: Record<string, unknown> | null = null;
      try {
        if (parentSession.metadata_json) {
          parentMetadata = JSON.parse(parentSession.metadata_json) as Record<string, unknown>;
        }
      } catch {
        parentMetadata = null;
      }

      let parentLabel = 'parent';
      let enforcedAllowedAgents: string[] | null = null;
      if (parentMetadata) {
        const metaWithAgent = parentMetadata as { agentType?: unknown };
        const parentAgentType = metaWithAgent.agentType;
        if (typeof parentAgentType === 'string' && parentAgentType.trim().length > 0) {
          parentLabel = parentAgentType;
        }

        const definitionCandidate = (parentMetadata as { definition?: unknown }).definition;
        if (definitionCandidate && typeof definitionCandidate === 'object' && definitionCandidate !== null) {
          const definitionRecord = definitionCandidate as Record<string, unknown>;
          const friendlyName = definitionRecord.name;
          if (typeof friendlyName === 'string' && friendlyName.trim().length > 0) {
            parentLabel = friendlyName;
          }
          if (Object.prototype.hasOwnProperty.call(definitionRecord, 'allowedAgents')) {
            const value = definitionRecord.allowedAgents;
            if (Array.isArray(value)) {
              enforcedAllowedAgents = value
                .map((entry) => (typeof entry === 'string' ? normalizeAgentType(entry) : ''))
                .filter((entry) => entry.length > 0);
            } else {
              enforcedAllowedAgents = [];
            }
          }
        }
      }

      if (enforcedAllowedAgents !== null) {
        if (enforcedAllowedAgents.length === 0) {
          throw new KlaudeError(
            `Agent ${parentLabel} is not permitted to spawn additional agents`,
            'E_AGENT_TYPE_NOT_ALLOWED',
          );
        }
        if (!enforcedAllowedAgents.includes(normalizedAgentType)) {
          throw new KlaudeError(
            `Agent ${parentLabel} cannot start agent type ${agentType}`,
            'E_AGENT_TYPE_NOT_ALLOWED',
          );
        }
      }
    }

    // Validate agent depth does not exceed configured maximum
    const maxAgentDepth = config.wrapper?.maxAgentDepth ?? 3;
    const parentDepth = calculateSessionDepth(parentSession.id);
    const newAgentDepth = parentDepth + 1;

    if (newAgentDepth > maxAgentDepth) {
      throw new KlaudeError(
        `Maximum agent depth (${maxAgentDepth}) exceeded. Parent at depth ${parentDepth}, cannot spawn child at depth ${newAgentDepth}.`,
        'E_MAX_DEPTH_EXCEEDED',
      );
    }

    // Load and resolve MCPs for this agent
    const { loadAvailableMcps } = await import('../mcp-loader.js');
    const { resolveMcpServers } = await import('../mcp-resolver.js');

    const availableMcps = await loadAvailableMcps(context.projectRoot);

    let parentResolvedMcps: Record<string, McpServerConfig> | undefined;
    if (parentSession.id !== rootSession.id && parentSession.metadata_json) {
      try {
        const parentMeta = JSON.parse(parentSession.metadata_json) as Record<string, unknown>;
        if (parentMeta.resolvedMcps && typeof parentMeta.resolvedMcps === 'object') {
          parentResolvedMcps = parentMeta.resolvedMcps as Record<string, McpServerConfig>;
        }
      } catch {
        // Parent metadata not parseable, continue without parent MCPs
      }
    }

    let resolvedMcps: Record<string, McpServerConfig> = {};
    if (agentDefinition) {
      try {
        resolvedMcps = resolveMcpServers({
          availableMcps,
          agentDefinition,
          parentMcps: parentResolvedMcps,
        });
      } catch (error) {
        // MCP resolution failure - log but don't fail agent spawn
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[mcp-resolution-failed] sessionId=${parentSession.id}, error=${message}`);
      }
    }

    const runtimeSelection = runtimeSelector.selectRuntime(agentDefinition);
    const runtimeKind = runtimeSelection.runtime;

    const metadata = {
      agentType,
      prompt: payload.prompt,
      requestedAt: new Date().toISOString(),
      instanceId,
      agentCount: payload.agentCount ?? null,
      options: payload.options ?? {},
      runtimeKind,
      runtimeFallback: runtimeSelection.fallbackRuntime ?? null,
      runtimeReason: runtimeSelection.reason,
      definition: agentDefinition
        ? {
            name: agentDefinition.name,
            description: agentDefinition.description,
            instructions: agentDefinition.instructions,
            allowedAgents: agentDefinition.allowedAgents,
            model: agentDefinition.model,
            color: agentDefinition.color,
            sourcePath: agentDefinition.sourcePath,
            scope: agentDefinition.scope,
            mcpServers: agentDefinition.mcpServers,
            inheritProjectMcps: agentDefinition.inheritProjectMcps,
            inheritParentMcps: agentDefinition.inheritParentMcps,
          }
        : null,
      resolvedMcps,
    };

    const session = (await import('@/db/index.js')).createSession(projectRecord.id, 'sdk', {
      parentId: parentSession.id,
      instanceId,
      title: agentDefinition?.name ?? `${agentType} agent`,
      prompt: payload.prompt,
      metadataJson: JSON.stringify(metadata),
    });

    debugLog(
      `[runtime-selection] sessionId=${session.id}, runtime=${runtimeKind}, fallback=${runtimeSelection.fallbackRuntime ?? 'none'}, reason=${runtimeSelection.reason}`,
    );

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      session.id,
      wrapperConfig?.projectsDir,
    );
    await ensureLogFile(sessionLogPath);

    const eventPayload = {
      agentType,
      parentSessionId: parentSession.id,
      options: payload.options ?? {},
      agentCount: payload.agentCount ?? null,
      definitionName: agentDefinition?.name ?? null,
      definitionModel: agentDefinition?.model ?? null,
      definitionSourcePath: agentDefinition?.sourcePath ?? null,
      allowedAgents: agentDefinition?.allowedAgents ?? [],
      definitionScope: agentDefinition?.scope ?? null,
      runtimeKind,
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

    if (runtimeKind === 'claude') {
      await runtimeLifecycleManager.startAgentRuntime(
        session,
        agentType,
        payload,
        shareResumeId,
        agentDefinition ?? null,
      );
    } else if (runtimeKind === 'gemini') {
      // Gemini runtime
      await runtimeLifecycleManager.startGeminiRuntime(
        runtimeSelection.fallbackRuntime as 'cursor' | undefined,
        session,
        agentType,
        payload,
        agentDefinition ?? null,
      );
    } else {
      // GPT runtime (codex or cursor)
      await runtimeLifecycleManager.startGptRuntime(
        runtimeKind as 'codex' | 'cursor',
        runtimeSelection.fallbackRuntime as 'codex' | 'cursor' | undefined,
        session,
        agentType,
        payload,
        agentDefinition ?? null,
      );
    }

    return {
      sessionId: session.id,
      status: session.status,
      logPath: sessionLogPath,
      agentType,
      prompt: session.prompt ?? payload.prompt,
      createdAt: session.created_at,
      instanceId,
      runtimeKind,
    };
  };

  /**
   * Handles message requests
   */
  async function handleMessage(payload: MessageRequestPayload): Promise<{ status: string; messagesQueued: number }> {
    debugLog(`[message-request] sessionId=${payload.sessionId}, prompt="${payload.prompt.slice(0, 50)}..."`);

    let runtime = agentRuntimes.get(payload.sessionId);
    const waitSeconds = typeof payload.waitSeconds === 'number' && isFinite(payload.waitSeconds)
      ? Math.max(0, payload.waitSeconds)
      : 5;

    if (runtime && runtime.runtimeKind !== 'claude') {
      throw new KlaudeError(
        'GPT runtime sessions do not support messaging; start a new run instead',
        'E_AGENT_MESSAGE_UNSUPPORTED',
      );
    }

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
      let storedAgentDefinition: AgentDefinition | null = null;
      let runtimeKind: 'claude' | 'cursor' = 'claude';
      try {
        if (session.metadata_json) {
          const meta = JSON.parse(session.metadata_json) as {
            agentType?: string;
            definition?: unknown;
            runtimeKind?: string;
          };
          if (meta && typeof meta.agentType === 'string' && meta.agentType.trim().length > 0) {
            derivedAgentType = meta.agentType;
          }
           if (meta && typeof meta.runtimeKind === 'string') {
             const normalized = meta.runtimeKind.toLowerCase() as 'claude' | 'cursor';
             if (normalized === 'cursor') {
               runtimeKind = 'cursor';
             }
           }

          const storedDefinitionRaw = meta?.definition;
          if (storedDefinitionRaw && typeof storedDefinitionRaw === 'object') {
            const definitionRecord = storedDefinitionRaw as Record<string, unknown>;
            const allowed = Array.isArray(definitionRecord.allowedAgents)
              ? definitionRecord.allowedAgents
                  .map((entry) => (typeof entry === 'string' ? normalizeAgentType(entry) : ''))
                  .filter((entry) => entry.length > 0)
              : [];

            const scopeCandidate = definitionRecord.scope;
            const scope: AgentDefinition['scope'] =
              scopeCandidate === 'project' || scopeCandidate === 'user' ? scopeCandidate : 'user';

            storedAgentDefinition = {
              type: normalizeAgentType(derivedAgentType),
              name:
                typeof definitionRecord.name === 'string' && definitionRecord.name.trim().length > 0
                  ? definitionRecord.name
                  : null,
              description:
                typeof definitionRecord.description === 'string' &&
                definitionRecord.description.trim().length > 0
                  ? definitionRecord.description
                  : null,
              instructions:
                typeof definitionRecord.instructions === 'string' &&
                definitionRecord.instructions.trim().length > 0
                  ? definitionRecord.instructions
                  : null,
              allowedAgents: allowed,
              model:
                typeof definitionRecord.model === 'string' && definitionRecord.model.trim().length > 0
                  ? definitionRecord.model
                  : null,
              color:
                typeof definitionRecord.color === 'string' && definitionRecord.color.trim().length > 0
                  ? definitionRecord.color
                  : null,
              sourcePath:
                typeof definitionRecord.sourcePath === 'string' &&
                definitionRecord.sourcePath.trim().length > 0
                  ? definitionRecord.sourcePath
                  : null,
              scope,
            };
          }
        }
      } catch {
        // ignore metadata parse errors; fallback to 'sdk'
      }

      if (runtimeKind !== 'claude') {
        throw new KlaudeError(
          'GPT runtime sessions do not support messaging; start a new run instead',
          'E_AGENT_MESSAGE_UNSUPPORTED',
        );
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
        const activeId = await claudeTuiLifecycle.waitForActiveClaudeSessionId(payload.sessionId, waitSeconds);
        if (activeId) {
          resumeId = activeId;
          messageSelectionReason = messageSelectionReason === 'unknown' ? 'waited_active' : `${messageSelectionReason}+waited_active`;
        }
      }

      if (!resumeId && waitSeconds > 0) {
        const lastId = await claudeTuiLifecycle.waitForClaudeSessionId(payload.sessionId, waitSeconds);
        if (lastId) {
          resumeId = lastId;
          messageSelectionReason = messageSelectionReason === 'unknown' ? 'waited_last' : `${messageSelectionReason}+waited_last`;
        }
      }

      // Launch a runtime for this existing session, using the incoming message as the initial prompt
      await runtimeLifecycleManager.startAgentRuntime(
        session as ReturnType<typeof import('@/db/index.js').createSession>,
        derivedAgentType,
        {
          agentType: derivedAgentType,
          prompt: payload.prompt,
          options: { detach: true },
        },
        resumeId,
        storedAgentDefinition,
      );

      runtime = agentRuntimes.get(payload.sessionId) ?? null as unknown as AgentRuntimeState;

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

    if (runtime.runtimeKind !== 'claude') {
      throw new KlaudeError(
        'GPT runtime sessions do not support messaging; start a new run instead',
        'E_AGENT_MESSAGE_UNSUPPORTED',
      );
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

  /**
   * Handles interrupt requests
   */
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

  /**
   * Handles checkout requests
   */
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
      claudeSessionId = await claudeTuiLifecycle.waitForActiveClaudeSessionId(targetSession.id, waitSeconds);
      if (claudeSessionId) {
        selectionReason = selectionReason === 'unknown' ? 'waited_active' : `${selectionReason}+waited_active`;
      }
      if (!claudeSessionId) {
        // Fallback to waiting for last_claude_session_id (SDK runtime will update this)
        debugLog(`[checkout-wait] Active link not found, waiting for last_claude_session_id...`);
        claudeSessionId = await claudeTuiLifecycle.waitForClaudeSessionId(targetSession.id, waitSeconds);
        if (claudeSessionId) {
          selectionReason = selectionReason === 'unknown' ? 'waited_last' : `${selectionReason}+waited_last`;
        }
      }
      const waitElapsed = Date.now() - claudeSessionStart;
      debugLog(`[checkout-wait-done] elapsed=${waitElapsed}ms, found=${claudeSessionId !== null}`);
    } else {
      debugLog(`[checkout-cached] Using cached Claude session ID`);
      if (waitSeconds > 0) {
        const activeId = await claudeTuiLifecycle.waitForActiveClaudeSessionId(targetSession.id, waitSeconds);
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

    if (targetSessionId !== currentSessionId) {
      const runtimeStopSeconds = Math.max(waitSeconds, 5);
      const stopStart = Date.now();
      const runtimeStopped = await ensureAgentRuntimeStopped(
        targetSessionId,
        runtimeStopSeconds,
        agentRuntimes,
        recordSessionEvent,
      );
      if (runtimeStopped) {
        const stopElapsed = Date.now() - stopStart;
        debugLog(`[checkout-runtime-stopped] sessionId=${targetSessionId}, elapsed=${stopElapsed}ms`);
        await recordSessionEvent(targetSessionId, 'wrapper.checkout.runtime_stopped', {
          requestedBySessionId: currentSessionId,
          waitSeconds: runtimeStopSeconds,
        });
      }
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
      await claudeTuiLifecycle.launchClaudeForSession(targetSessionId, {
        resumeClaudeSessionId: claudeSessionId,
        sourceSessionId: currentSessionId,
        isInitialLaunch: false,
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
        claudeTuiLifecycle.terminateCurrentClaudeProcess();
        const terminateElapsed = Date.now() - terminateStart;
        debugLog(`[checkout-terminate-sent] elapsed=${terminateElapsed}ms`);
      } catch (error) {
        state.pendingSwitch = null;
        reject(error);
      }
    });
  }

  /**
   * Handles status requests
   */
  function handleStatus(): InstanceStatusPayload {
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

  /**
   * Handles ping requests
   */
  function handlePing(): { pong: boolean; timestamp: string } {
    return {
      pong: true,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Creates the main request router
   */
  function createRequestRouter(): InstanceRequestHandler {
    return async (request: InstanceRequest) => {
      switch (request.action) {
        case 'ping':
          return handlePing();
        case 'status':
          return handleStatus();
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
  }

  return {
    handleStartAgent,
    handleMessage,
    handleInterrupt,
    handleCheckout,
    handleStatus,
    handlePing,
    createRequestRouter,
  };
}
