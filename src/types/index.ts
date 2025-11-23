/**
 * MCP server configuration types (matches Claude Code .mcp.json format and SDK types)
 */
export type McpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Claude CLI flags configuration
 */
export interface ClaudeCliFlags {
  /** One-time flags (only used on initial launch) */
  oneTime: string[];
  /** Persistent flags (used on all launches including checkouts) */
  persistent: string[];
}

/**
 * Runtime kind discriminator for agent processes
 */
export type RuntimeKind = 'claude' | 'codex' | 'cursor' | 'gemini';

/**
 * GPT runtime preference setting
 * - 'codex': Prefer OpenAI Codex CLI
 * - 'cursor': Prefer Cursor CLI
 * - 'auto': Try codex first, fallback to cursor
 */
export type GptRuntimePreference = 'codex' | 'cursor' | 'auto';

/**
 * Codex-specific runtime configuration
 */
export interface CodexRuntimeConfig {
  binaryPath?: string;
  startupRetries?: number;
  startupRetryDelayMs?: number;
  startupRetryJitterMs?: number;
}

/**
 * Cursor-specific runtime configuration
 */
export interface CursorRuntimeConfig {
  binaryPath?: string;
  startupRetries?: number;
  startupRetryDelayMs?: number;
  startupRetryJitterMs?: number;
}

/**
 * Gemini-specific runtime configuration
 */
export interface GeminiRuntimeConfig {
  binaryPath?: string;
  startupRetries?: number;
  startupRetryDelayMs?: number;
  startupRetryJitterMs?: number;
}

/**
 * GPT runtime configuration (Codex, Cursor, and Gemini)
 */
export interface GptRuntimeConfig {
  preferredRuntime?: GptRuntimePreference;
  fallbackOnError?: boolean;
  codex?: CodexRuntimeConfig;
  cursor?: CursorRuntimeConfig;
  gemini?: GeminiRuntimeConfig;
}

/**
 * Configuration structure from ~/.klaude/config.yaml
 */
export interface KlaudeConfig {
  sdk: {
    model: string;
    permissionMode?: string;
    fallbackModel?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
  };
  server?: {
    enabled: boolean;
    port: number;
  };
  wrapper?: {
    claudeBinary?: string;
    socketDir?: string;
    projectsDir?: string;
    cliFlags?: ClaudeCliFlags;
    maxAgentDepth?: number;
    switch?: {
      graceSeconds?: number;
    };
    /** GPT runtime configuration (Codex + Cursor) */
    gpt?: GptRuntimeConfig;
    /** @deprecated Use wrapper.gpt.cursor instead. Kept for backward compatibility. */
    cursor?: {
      startupRetries?: number;
      startupRetryDelayMs?: number;
      startupRetryJitterMs?: number;
    };
  };
}

/**
 * Parsed CLI arguments
 */
export interface ParsedArgs {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/**
 * Database query result wrapper
 */
export interface QueryResult<T> {
  data: T[];
  count: number;
  error?: string;
}

/**
 * Session log event types
 */
export interface SessionLogEvent {
  timestamp?: string;
  kind: string;
  payload?: unknown;
}

export interface AgentRuntimeMessage extends SessionLogEvent {
  kind: 'agent.runtime.message';
  payload: {
    messageType: 'assistant' | 'stream_event' | 'user' | string;
    text?: string;
  };
}

export interface AgentRuntimeResult extends SessionLogEvent {
  kind: 'agent.runtime.result';
  payload: {
    result?: string;
  };
}

export interface AgentRuntimeError extends SessionLogEvent {
  kind: 'agent.runtime.error';
  payload: {
    error?: string;
    message?: string;
  };
}

export interface AgentSessionCreated extends SessionLogEvent {
  kind: 'agent.session.created';
  payload: {
    agentType: string;
    sessionId?: string;
  };
}

export interface AgentRuntimeClaudeSession extends SessionLogEvent {
  kind: 'agent.runtime.claude-session';
  payload: {
    sessionId: string;
  };
}

export interface WrapperCheckoutResumeSelected extends SessionLogEvent {
  kind: 'wrapper.checkout.resume_selected';
  payload: {
    selectedResumeId: string;
  };
}

// Export all database entity types
export * from './db.js';
