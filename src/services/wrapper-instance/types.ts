import type { ChildProcess } from 'node:child_process';
import type { ClaudeCliFlags } from '@/types/index.js';
import type { InstanceRequest } from '@/types/instance-ipc.js';

/**
 * Options for starting the wrapper instance
 */
export interface WrapperStartOptions {
  projectCwd?: string;
  claudeCliFlags?: ClaudeCliFlags;
}

/**
 * Result of Claude process exit
 */
export interface ClaudeExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Handler for instance IPC requests
 */
export type InstanceRequestHandler = (request: InstanceRequest) => Promise<unknown>;

/**
 * Events emitted by agent runtime processes
 */
export type AgentRuntimeEvent =
  | { type: 'status'; status: 'starting' | 'running' | 'completed'; detail?: string }
  | { type: 'message'; messageType: string; payload: unknown; text?: string | null }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result?: unknown; stopReason?: string | null }
  | { type: 'claude-session'; sessionId: string; transcriptPath?: string | null }
  | { type: 'done'; status: 'done' | 'failed' | 'interrupted'; reason?: string };

/**
 * Metadata for Cursor runtime retry logic
 */
export interface CursorRuntimeMeta {
  attempts: number;
  maxAttempts: number;
  pendingRetryTimer: NodeJS.Timeout | null;
  cancelled: boolean;
  awaitingRetry: boolean;
  lastExitStatus?: 'done' | 'failed' | 'interrupted';
}

/**
 * State of an agent runtime process
 */
export interface AgentRuntimeState {
  sessionId: string;
  process: ChildProcess;
  runtimeProcessId: number | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
  logPath: string;
  detached: boolean;
  runtimeKind: 'claude' | 'cursor' | 'codex' | 'gemini';
  cursorMeta?: CursorRuntimeMeta;
}

/**
 * Pending session checkout/switch state
 */
export interface PendingSwitch {
  targetSessionId: string;
  targetClaudeSessionId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Main wrapper instance state
 */
export interface WrapperState {
  currentSessionId: string;
  currentClaudeProcess: ChildProcess | null;
  currentClaudePid: number | null;
  currentRuntimeProcessId: number | null;
  pendingSwitch: PendingSwitch | null;
  killTimer: NodeJS.Timeout | null;
}
