/**
 * Core type definitions for Klaude CLI
 */

export type SessionStatus = 'created' | 'running' | 'completed' | 'failed';
export type AgentStatus = 'idle' | 'running' | 'interrupted' | 'completed' | 'failed';
export type AgentType = 'orchestrator' | 'planner' | 'programmer' | 'junior-engineer' | 'context-engineer' | 'senior-engineer' | 'library-docs-writer' | 'non-dev';

/**
 * Session represents a unique agent execution context
 */
export interface Session {
  id: string;
  agentType: AgentType;
  parentSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  status: SessionStatus;
  prompt: string;
  result?: string;
  metadata: Record<string, unknown>;
}

/**
 * Agent represents an active or managed agent instance
 */
export interface Agent {
  sessionId: string;
  type: AgentType;
  status: AgentStatus;
  abortController: AbortController;
  startedAt: Date;
  completedAt?: Date;
}

/**
 * Message for inter-agent communication
 */
export interface Message {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  content: string;
  createdAt: Date;
  readAt?: Date;
}

/**
 * Service manager interfaces (defined in respective modules)
 */
export interface ISessionManager {
  createSession(agentType: AgentType, prompt: string, parentSessionId?: string): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  updateSession(sessionId: string, updates: Partial<Session>): Promise<void>;
  closeSession(sessionId: string, result: string): Promise<void>;
  listSessions(filter?: Partial<Session>): Promise<Session[]>;
  activateSession(sessionId: string): Promise<void>;
  getActiveSessionId(): Promise<string | null>;
  getParentChain(sessionId: string): Promise<Session[]>;
}

export interface IAgentManager {
  spawn(agentType: AgentType, prompt: string, options?: StartAgentOptions): Promise<Agent>;
  interrupt(sessionId: string): Promise<void>;
  getAgent(sessionId: string): Agent | null;
  listActive(): Agent[];
  wait(sessionId: string, maxWaitMs?: number): Promise<void>;
}

export interface IMessageQueue {
  enqueue(fromSessionId: string, toSessionId: string, content: string): Promise<Message>;
  dequeue(sessionId: string): Promise<Message[]>;
  subscribe(sessionId: string, callback: (message: Message) => void): void;
  ack(messageId: string): Promise<void>;
}

export interface ILogger {
  log(sessionId: string, type: LogEntry['type'], content: string): Promise<void>;
  stream(sessionId: string): Promise<LogEntry[]>;
  flush(sessionId: string): Promise<void>;
}

/**
 * CLI Context passed through command handlers
 */
export interface CLIContext {
  activeSessionId?: string;
  config: KlaudeConfig;
  sessionManager: ISessionManager;
  agentManager: IAgentManager;
  messageQueue: IMessageQueue;
  logger: ILogger;
}

/**
 * Configuration structure from ~/.klaude/config.yaml
 */
export interface KlaudeConfig {
  sdk: {
    model: string;
    maxThinkingTokens?: number;
    permissionMode?: string;
    fallbackModel?: string;
  };
  session: {
    autoSaveIntervalMs?: number;
    logRetentionDays?: number;
    maxConcurrentAgents?: number;
  };
  server?: {
    enabled: boolean;
    port: number;
  };
}

/**
 * Result of command execution
 */
export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
  sessionId?: string;
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
 * Options for starting an agent
 */
export interface StartAgentOptions {
  checkout?: boolean;
  share?: boolean;
  detach?: boolean;
  count?: number;
}

/**
 * Options for reading session logs
 */
export interface ReadSessionOptions {
  tail?: boolean;
  summary?: boolean;
  lines?: number;
}

/**
 * Log entry format
 */
export interface LogEntry {
  timestamp: Date;
  sessionId: string;
  type: 'assistant' | 'user' | 'tool_use' | 'system' | 'error';
  content: string;
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
 * Session metadata for display
 */
export interface SessionMetadata {
  id: string;
  agentType: AgentType;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  durationMs?: number;
  firstMessage?: string;
  lastMessage?: string;
}
