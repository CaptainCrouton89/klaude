/**
 * Claude TUI process lifecycle management
 *
 * Handles launching, terminating, and managing the lifecycle of Claude TUI processes,
 * including session ID tracking, graceful shutdown, and session switching.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  getInstanceById,
  getSessionById,
  createEvent,
  createRuntimeProcess,
  updateSessionStatus,
  updateSessionProcessPid,
  markSessionEnded,
  markRuntimeExited,
  markInstanceEnded,
  listClaudeSessionLinks,
} from '@/db/index.js';
import type { Project, ClaudeCliFlags, KlaudeConfig } from '@/types/index.js';
import type { ProjectContext } from '@/services/project-context.js';
import { KlaudeError } from '@/utils/error-handler.js';
import { abbreviateSessionId } from '@/utils/cli-helpers.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import { appendSessionEvent } from '@/utils/logger.js';
import type { RecordSessionEvent } from './event-recorder.js';
import type { ClaudeExitResult, WrapperState, PendingSwitch } from './types.js';
import { debugLog, verboseLog, ensureLogFile } from './utils.js';
import { markInstanceEnded as markRegistryInstanceEnded } from '@/services/instance-registry.js';

/**
 * Dependencies required by Claude TUI lifecycle functions
 */
export interface ClaudeTuiLifecycleDeps {
  /** Mutable state object (passed by reference) */
  state: WrapperState;
  /** Event recorder function */
  recordSessionEvent: RecordSessionEvent;
  /** Project context */
  context: ProjectContext;
  /** Project database record */
  projectRecord: Project;
  /** Instance ID */
  instanceId: string;
  /** Root session record */
  rootSession: { id: string };
  /** Wrapper configuration */
  wrapperConfig: KlaudeConfig['wrapper'];
  /** Grace period in seconds for SIGTERM → SIGKILL */
  graceSeconds: number;
  /** Path to Claude binary */
  claudeBinary: string;
  /** Shutdown promise resolver */
  shutdownResolve: (() => void) | null;
  /** Shutdown promise */
  shutdownPromise: Promise<void>;
}

/**
 * Claude TUI lifecycle management functions
 */
export interface ClaudeTuiLifecycle {
  waitForClaudeSessionId: (sessionId: string, waitSeconds: number) => Promise<string | null>;
  waitForActiveClaudeSessionId: (klaudeSessionId: string, waitSeconds: number) => Promise<string | null>;
  clearKillTimer: () => void;
  terminateCurrentClaudeProcess: () => void;
  launchClaudeForSession: (
    sessionId: string,
    options?: { resumeClaudeSessionId?: string; sourceSessionId?: string; isInitialLaunch?: boolean },
  ) => Promise<void>;
  handleClaudeExit: (sessionId: string, exitResult: ClaudeExitResult) => Promise<void>;
  handleClaudeError: (sessionId: string, error: Error) => Promise<void>;
  finalize: (status: 'done' | 'failed' | 'interrupted', exitInfo: ClaudeExitResult | null) => Promise<void>;
}

/**
 * Maps Claude exit result to session status
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
 * Creates Claude TUI lifecycle management functions
 *
 * @param deps - Dependencies required for lifecycle management
 * @returns Object containing all lifecycle management functions
 */
export function createClaudeTuiLifecycle(deps: ClaudeTuiLifecycleDeps): ClaudeTuiLifecycle {
  const {
    state,
    recordSessionEvent,
    context,
    projectRecord,
    instanceId,
    rootSession,
    wrapperConfig,
    graceSeconds,
    claudeBinary,
  } = deps;

  let finalized = false;
  let shutdownResolve = deps.shutdownResolve;

  /**
   * Waits for a Claude session ID to be set on a Klaude session
   *
   * Polls the session record until last_claude_session_id is populated or timeout.
   */
  async function waitForClaudeSessionId(
    sessionId: string,
    waitSeconds: number,
  ): Promise<string | null> {
    const normalizedWait = Number.isFinite(waitSeconds) ? Math.max(0, waitSeconds) : 0;
    const deadline = Date.now() + normalizedWait * 1000;
    const pollDelayMs = 200;

    debugLog(`[wait-claude-session-id] sessionId=${sessionId}, waitSeconds=${waitSeconds}`);

    let pollCount = 0;
    while (true) {
      pollCount++;
      const session = getSessionById(sessionId);
      if (!session) {
        throw new KlaudeError(`Session ${sessionId} not found`, 'E_SESSION_NOT_FOUND');
      }

      verboseLog(`[wait-claude-session-id] poll=${pollCount}, last_claude_session_id=${session.last_claude_session_id || 'null'}`);

      if (session.last_claude_session_id) {
        debugLog(`[wait-claude-session-id] Found Claude session ID after ${pollCount} polls: ${session.last_claude_session_id}`);
        return session.last_claude_session_id;
      }

      if (normalizedWait === 0 || Date.now() >= deadline) {
        debugLog(`[wait-claude-session-id] Timeout after ${pollCount} polls (deadline reached)`);
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

  /**
   * Waits for an active Claude session link to exist for a Klaude session
   *
   * Polls the claude_session_links table for an active (ended_at = null) link.
   */
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

  /**
   * Clears the kill timer if it exists
   */
  function clearKillTimer(): void {
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }
  }

  /**
   * Terminates the current Claude process with SIGTERM, followed by SIGKILL after grace period
   */
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

  /**
   * Launches a Claude TUI process for a given session
   *
   * @param sessionId - The Klaude session ID to launch Claude for
   * @param options - Launch options (resume session ID, source session, initial launch flag)
   */
  async function launchClaudeForSession(
    sessionId: string,
    options: { resumeClaudeSessionId?: string; sourceSessionId?: string; isInitialLaunch?: boolean } = {},
  ): Promise<void> {
    debugLog(`[claude-launch] sessionId=${sessionId}, resume=${options.resumeClaudeSessionId ?? 'none'}`);

    const args: string[] = [];
    if (options.resumeClaudeSessionId) {
      args.push('--resume', options.resumeClaudeSessionId);
    }

    // Retrieve and apply CLI flags from instance metadata
    const instance = getInstanceById(instanceId);
    let storedFlags: ClaudeCliFlags | null = null;
    if (instance?.metadata_json) {
      try {
        const metadata = JSON.parse(instance.metadata_json) as { claudeCliFlags?: ClaudeCliFlags };
        storedFlags = metadata.claudeCliFlags ?? null;
      } catch {
        // ignore parse errors
      }
    }

    // Add persistent flags to all launches
    if (storedFlags?.persistent && storedFlags.persistent.length > 0) {
      args.push(...storedFlags.persistent);
    }

    // Add one-time flags only to initial launch
    if (options.isInitialLaunch && storedFlags?.oneTime && storedFlags.oneTime.length > 0) {
      args.push(...storedFlags.oneTime);
    }

    const sessionIdShort = abbreviateSessionId(sessionId);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KLAUDE_PROJECT_HASH: context.projectHash,
      KLAUDE_INSTANCE_ID: instanceId,
      KLAUDE_SESSION_ID: sessionId,
      KLAUDE_SESSION_ID_SHORT: sessionIdShort,
      KLAUDE_NODE_BIN: process.execPath,
      KLAUDE_NODE_MODULE_VERSION: process.versions.modules,
      KLAUDE_NODE_VERSION: process.version,
    };
    delete env.KLAUDE_NODE_REEXEC;
    env.KLAUDE_NODE_REEXEC = '0';

    debugLog(`[claude-env] Setting environment variables:`);
    debugLog(`  KLAUDE_PROJECT_HASH=${context.projectHash}`);
    debugLog(`  KLAUDE_INSTANCE_ID=${instanceId}`);
    debugLog(`  KLAUDE_SESSION_ID=${sessionId}`);
    debugLog(`  KLAUDE_SESSION_ID_SHORT=${sessionIdShort}`);
    debugLog(`[claude-spawn] stdin.isTTY=${process.stdin.isTTY}, stdout.isTTY=${process.stdout.isTTY}`);

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      sessionId,
      wrapperConfig?.projectsDir,
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
          `Claude session hook did not fire within ${hookWaitSeconds}s.\n\n` +
          `Run the following command to automatically install hooks:\n` +
          `  klaude setup-hooks\n\n` +
          `Or manually add to ~/.claude/settings.json:\n` +
          `{\n  "hooks": {\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "klaude hook session-start" }] }],\n` +
          `    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "klaude hook session-end" }] }]\n  }\n}`,
          'E_HOOK_TIMEOUT',
        );
      }
    }
  }

  /**
   * Handles Claude process exit event
   *
   * Updates session status, records events, and handles session switching if pending.
   */
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
          isInitialLaunch: false,
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

  /**
   * Handles Claude process error event
   *
   * Updates session status to failed and cleans up resources.
   */
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

  /**
   * Finalizes the wrapper instance
   *
   * Marks sessions and instance as ended, sets exit code, and resolves shutdown promise.
   */
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

  return {
    waitForClaudeSessionId,
    waitForActiveClaudeSessionId,
    clearKillTimer,
    terminateCurrentClaudeProcess,
    launchClaudeForSession,
    handleClaudeExit,
    handleClaudeError,
    finalize,
  };
}
