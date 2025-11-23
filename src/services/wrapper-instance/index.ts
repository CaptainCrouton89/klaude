/**
 * Wrapper instance orchestrator
 *
 * Main entry point that composes all wrapper-instance modules into a cohesive system.
 * Manages project initialization, socket server lifecycle, Claude TUI spawning, and IPC request routing.
 */

import { fileURLToPath } from 'node:url';
import {
  initializeDatabase,
  getProjectByHash,
  createProject,
  createInstance,
  createSession,
  closeDatabase,
} from '@/db/index.js';
import { loadConfig } from '@/services/config-loader.js';
import { prepareProjectContext } from '@/services/project-context.js';
import { RuntimeSelector } from '@/services/runtime-selector.js';
import { RuntimeValidator } from '@/services/runtime-validator.js';
import {
  registerInstance,
} from '@/services/instance-registry.js';
import { KlaudeError } from '@/utils/error-handler.js';
import { getInstanceSocketPath, getSessionLogPath } from '@/utils/path-helper.js';
import { generateULID } from '@/utils/ulid.js';

// Import all module factories
import { createSocketServer } from './socket-server.js';
import { createEventRecorder } from './event-recorder.js';
import { createRuntimeLifecycleManager } from './runtime-lifecycle.js';
import { createClaudeTuiLifecycle } from './claude-tui-lifecycle.js';
import { createIpcHandlers } from './ipc-handlers.js';

// Import types and utilities
import type { WrapperStartOptions, AgentRuntimeState, WrapperState } from './types.js';
import { debugLog, detectTtyPath, ensureLogFile } from './utils.js';

/**
 * Starts the wrapper instance
 *
 * Main orchestrator that:
 * 1. Initializes project context and database
 * 2. Creates module instances via factory functions
 * 3. Starts socket server with IPC request routing
 * 4. Launches initial Claude TUI process
 * 5. Waits for shutdown signal
 *
 * @param options - Configuration options including project directory and CLI flags
 */
export async function startWrapperInstance(options: WrapperStartOptions = {}): Promise<void> {
  const cwd = options.projectCwd ?? process.cwd();

  debugLog(
    `[node-runtime] version=${process.version}, modules=${process.versions.modules}, execPath=${process.execPath}`,
  );

  // ========================================
  // 1. INITIALIZATION
  // ========================================

  const config = await loadConfig();
  const context = await prepareProjectContext(cwd);

  const db = await initializeDatabase();
  void db; // Keep database reference in scope

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

  const ttyPath = detectTtyPath();

  await registerInstance(context, {
    instanceId,
    pid: process.pid,
    tty: ttyPath,
    socketPath,
  });

  const instanceMetadata = options.claudeCliFlags
    ? JSON.stringify({ claudeCliFlags: options.claudeCliFlags })
    : null;

  createInstance(instanceId, projectRecord.id, process.pid, ttyPath, instanceMetadata);

  const rootSession = createSession(projectRecord.id, 'tui', {
    instanceId,
    title: 'Claude TUI',
    metadataJson: JSON.stringify({ projectRoot: context.projectRoot }),
  });

  // ========================================
  // 2. RUNTIME VALIDATION
  // ========================================

  const runtimeValidation = await RuntimeValidator.validateGptRuntimes(config);

  if (
    !runtimeValidation.codex.available &&
    !runtimeValidation.cursor.available &&
    !runtimeValidation.gemini.available
  ) {
    console.warn('⚠️  No GPT/Gemini runtime available! GPT and Gemini models will fail.');
    console.warn('   Install Codex: npm i -g @openai/codex');
    console.warn('   Install Cursor: curl https://cursor.com/install -fsS | bash');
    console.warn('   Install Gemini: npm i -g @google/gemini-cli');
  } else {
    if (runtimeValidation.codex.available) {
      debugLog(`[runtime-validation] Codex available: ${runtimeValidation.codex.version}`);
    } else {
      console.warn('⚠️  Codex CLI not found. Install: npm i -g @openai/codex');
    }

    if (runtimeValidation.cursor.available) {
      debugLog(`[runtime-validation] Cursor available: ${runtimeValidation.cursor.version}`);
    } else {
      console.warn('⚠️  Cursor CLI not found. Some GPT models may be unavailable.');
    }

    if (runtimeValidation.gemini.available) {
      debugLog(`[runtime-validation] Gemini available: ${runtimeValidation.gemini.version}`);
    } else {
      console.warn('⚠️  Gemini CLI not found. Gemini models will be unavailable.');
      console.warn('   Install: npm i -g @google/gemini-cli');
    }
  }

  // ========================================
  // 3. CONFIGURATION
  // ========================================

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

  const agentRuntimeEntryPath = fileURLToPath(
    new URL('../../runtime/agent-runtime.js', import.meta.url),
  );

  // ========================================
  // 4. SHARED STATE INITIALIZATION
  // ========================================

  const agentRuntimes = new Map<string, AgentRuntimeState>();
  const graceSeconds = Math.max(0, wrapperConfig.switch?.graceSeconds ?? 1);
  const finalized = { value: false };

  const state: WrapperState = {
    currentSessionId: rootSession.id,
    currentClaudeProcess: null,
    currentClaudePid: null,
    currentRuntimeProcessId: null,
    pendingSwitch: null,
    killTimer: null,
  };

  let shutdownResolve: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });

  const runtimeSelector = new RuntimeSelector(config);

  // ========================================
  // 5. MODULE COMPOSITION
  // ========================================

  // Create event recorder
  const recordSessionEvent = createEventRecorder(context, projectRecord, wrapperConfig);

  // Create runtime lifecycle manager
  const runtimeLifecycleManager = createRuntimeLifecycleManager({
    agentRuntimes,
    recordSessionEvent,
    config,
    context,
    projectRecord,
    instanceId,
    rootSession,
    wrapperConfig,
    claudeBinary,
    agentRuntimeEntryPath,
  });

  // Create Claude TUI lifecycle manager
  const claudeTuiLifecycle = createClaudeTuiLifecycle({
    state,
    recordSessionEvent,
    context,
    projectRecord,
    instanceId,
    rootSession,
    wrapperConfig,
    graceSeconds,
    claudeBinary,
    shutdownResolve,
    shutdownPromise,
  });

  // Create IPC handlers
  const ipcHandlers = createIpcHandlers({
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
  });

  // ========================================
  // 6. MAIN LIFECYCLE
  // ========================================

  try {
    // Start socket server with request router
    const { server, cleanup } = await createSocketServer(
      socketPath,
      ipcHandlers.createRequestRouter(),
    );
    void server; // Keep server reference in scope

    // Record wrapper startup
    await recordSessionEvent(rootSession.id, 'wrapper.start', { instanceId });

    // Launch initial Claude TUI process
    await claudeTuiLifecycle.launchClaudeForSession(rootSession.id, { isInitialLaunch: true });

    // Wait for shutdown
    await shutdownPromise;

    // Cleanup socket server
    await cleanup();
  } catch (error) {
    if (!finalized.value) {
      await claudeTuiLifecycle.finalize('failed', null);
    }
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[wrapper-error] ${message}`);
    throw error;
  } finally {
    // Ensure database is closed
    try {
      await closeDatabase();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`[database-close-error] ${message}`);
    }
  }
}
