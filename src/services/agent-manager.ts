/**
 * Agent spawning and management system
 */

import { DEFAULT_AGENT_TIMEOUT } from '@/config/constants.js';
import { getDatabase } from '@/db/database.js';
import { expandHome } from '@/utils/path-helper.js';
import {
  Agent,
  AgentStatus,
  AgentType,
  IAgentManager,
  ILogger,
  ISessionManager,
  KlaudeConfig,
  LogEntryType,
  StartAgentOptions,
} from '@/types/index.js';
import {
  type Options as ClaudeQueryOptions,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Database row interface for active_agents table
 */
interface ActiveAgentRow {
  session_id: string;
  type: string;
  status: string;
  started_at: number;
  completed_at: number | null;
}

function rowToAgent(row: ActiveAgentRow): Agent {
  return {
    sessionId: row.session_id,
    type: row.type as AgentType,
    status: row.status as AgentStatus,
    abortController: new AbortController(),
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  };
}

/**
 * Agent Manager implementation
 */
export class AgentManager implements IAgentManager {
  private agents: Map<string, Agent> = new Map();
  private sessionManager: ISessionManager;
  private logger: ILogger;
  private waiters: Map<string, Promise<void>> = new Map();
  private config: KlaudeConfig;

  constructor(sessionManager: ISessionManager, logger: ILogger, config: KlaudeConfig) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.config = config;
  }

  /**
   * Spawn a new agent
   */
  async spawn(
    agentType: AgentType,
    prompt: string,
    options: StartAgentOptions = {}
  ): Promise<Agent> {
    // Create session for the agent
    const parentSessionId = await this.sessionManager.getActiveSessionId();
    const session = await this.sessionManager.createSession(agentType, prompt, parentSessionId || undefined);

    // Create agent record
    const agent: Agent = {
      sessionId: session.id,
      claudeSessionId: undefined,
      type: agentType,
      status: 'idle',
      abortController: new AbortController(),
      startedAt: new Date(),
    };

    // Store in memory
    this.agents.set(session.id, agent);

    // Store in database
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO active_agents (session_id, type, status, started_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(session.id, agentType, 'idle', Date.now());

    // Log agent spawn
    await this.logger.log(session.id, 'system', `Agent spawned: ${agentType}`);
    await this.logger.log(session.id, 'user', prompt);

    // Update session status
    await this.sessionManager.updateSession(session.id, { status: 'running' });
    await this.updateAgentStatus(session.id, 'running');
    this.emitStream(options, 'system', `Agent ${agentType} started (session ${session.id})`);

    // Execute agent work asynchronously
    void this.runAgentSession(agent, prompt, options);

    return agent;
  }

  /**
   * Run agent workflow using Claude Agent SDK and emit streamed output
   */
  private async runAgentSession(agent: Agent, prompt: string, options: StartAgentOptions = {}): Promise<void> {
    const sessionId = agent.sessionId;
    const collectedAssistantMessages: string[] = [];
    let linkedClaudeSessionId: string | null = null;

    try {
      // Dynamically import the SDK with expanded home path
      const sdkPath = expandHome('~/.claude/claude-cli/sdk.mjs');
      const { query } = await import(sdkPath);

      const stream = query({
        prompt,
        options: this.buildQueryOptions(),
      });

      for await (const message of stream as AsyncIterable<SDKMessage>) {
        linkedClaudeSessionId = await this.maybeLinkClaudeSessionId(sessionId, linkedClaudeSessionId, message);

        if (message.type === 'assistant') {
          const assistantText = this.extractAssistantText(message as SDKAssistantMessage);
          if (assistantText) {
            collectedAssistantMessages.push(assistantText);
            await this.logger.log(sessionId, 'assistant', assistantText);
            this.emitStream(options, 'assistant', assistantText);
          }
        } else if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;
          if (resultMessage.is_error) {
            const errorText = this.extractResultText(resultMessage, collectedAssistantMessages) || 'Agent reported an unknown error.';
            await this.logger.log(sessionId, 'error', errorText);
            await this.failAgent(sessionId, errorText);
            const errorObj = new Error(errorText);
            this.emitStream(options, 'error', errorText);
            options.onError?.(errorObj);
            return;
          }

          const resultText = this.extractResultText(resultMessage, collectedAssistantMessages);
          if (!collectedAssistantMessages.length && resultText) {
            await this.logger.log(sessionId, 'assistant', resultText);
            this.emitStream(options, 'assistant', resultText);
          }
          await this.completeAgent(sessionId, resultText);
          this.emitStream(options, 'system', 'Agent completed');
          options.onComplete?.({ sessionId, result: resultText });
          return;
        }
      }

      // Stream ended without explicit result message, consider collected assistant output as final result.
      const fallbackResult = collectedAssistantMessages.join('\n').trim();
      await this.completeAgent(sessionId, fallbackResult);
      if (!collectedAssistantMessages.length && fallbackResult) {
        await this.logger.log(sessionId, 'assistant', fallbackResult);
        this.emitStream(options, 'assistant', fallbackResult);
      }
      this.emitStream(options, 'system', 'Agent completed');
      options.onComplete?.({ sessionId, result: fallbackResult });
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      await this.logger.log(sessionId, 'error', errorObj.message);
      await this.failAgent(sessionId, errorObj.message);
      this.emitStream(options, 'error', errorObj.message);
      options.onError?.(errorObj);
    }
  }

  /**
   * Build SDK query options from configuration
   */
  private buildQueryOptions(): ClaudeQueryOptions {
    const queryOptions: ClaudeQueryOptions = {};

    if (this.config.sdk?.model) {
      queryOptions.model = this.config.sdk.model;
    }
    if (this.config.sdk?.maxThinkingTokens !== undefined) {
      queryOptions.maxThinkingTokens = this.config.sdk.maxThinkingTokens;
    }
    if (this.config.sdk?.permissionMode) {
      queryOptions.permissionMode = this.config.sdk.permissionMode as ClaudeQueryOptions['permissionMode'];
    }
    if (this.config.sdk?.fallbackModel) {
      queryOptions.fallbackModel = this.config.sdk.fallbackModel;
    }
    if (this.config.wrapper?.claudeBinary) {
      queryOptions.pathToClaudeCodeExecutable = this.config.wrapper.claudeBinary;
    }

    return queryOptions;
  }

  /**
   * Record the Claude session ID associated with this Klaude session if present.
   */
  private async maybeLinkClaudeSessionId(
    sessionId: string,
    currentClaudeSessionId: string | null,
    message: SDKMessage
  ): Promise<string | null> {
    const candidate = this.extractClaudeSessionId(message);
    if (!candidate || candidate === currentClaudeSessionId) {
      return currentClaudeSessionId;
    }

    await this.sessionManager.updateSession(sessionId, { claudeSessionId: candidate });
    if (!currentClaudeSessionId) {
      await this.logger.log(sessionId, 'system', `Linked to Claude session ${candidate}`);
    }
    const agent = this.agents.get(sessionId);
    if (agent) {
      agent.claudeSessionId = candidate;
    }
    return candidate;
  }

  /**
   * Pull Claude session ID off of SDK messages when available.
   */
  private extractClaudeSessionId(message: SDKMessage): string | null {
    if (!message || typeof message !== 'object') {
      return null;
    }
    const candidate = (message as { session_id?: unknown }).session_id;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    return null;
  }

  /**
   * Emit streaming events back to the caller if configured
   */
  private emitStream(options: StartAgentOptions | undefined, type: LogEntryType, content: string, partial = false): void {
    if (!options?.onStream || !content) {
      return;
    }
    options.onStream({
      type,
      content,
      partial,
    });
  }

  /**
   * Extract readable assistant text from SDK assistant messages
   */
  private extractAssistantText(message: SDKAssistantMessage): string | null {
    const payload = message.message as Record<string, unknown> | undefined;
    if (!payload) {
      return null;
    }

    const parts = this.collectContentText((payload as { content?: unknown }).content);
    if (parts.length > 0) {
      return parts.join('\n').trim();
    }

    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }

    const completion = (payload as { completion?: unknown }).completion;
    if (typeof completion === 'string' && completion.trim()) {
      return completion.trim();
    }

    return null;
  }

  /**
   * Collapse nested content blocks into plain text
   */
  private collectContentText(content: unknown, depth = 0): string[] {
    if (!content) {
      return [];
    }
    if (typeof content === 'string') {
      return [content];
    }
    if (depth > 5) {
      return [];
    }

    if (Array.isArray(content)) {
      const segments: string[] = [];
      for (const item of content) {
        segments.push(...this.collectContentText(item, depth + 1));
      }
      return segments;
    }

    if (typeof content === 'object') {
      const block = content as Record<string, unknown>;

      if (typeof block.text === 'string' && block.text.trim()) {
        return [block.text];
      }

      if (Array.isArray(block.content)) {
        return this.collectContentText(block.content, depth + 1);
      }

      if (typeof block.type === 'string' && block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        return [`[tool use: ${name}]`];
      }
    }

    return [];
  }

  /**
   * Extract final result text from SDK result message
   */
  private extractResultText(message: SDKResultMessage, assistantMessages: string[]): string {
    if ('result' in message) {
      const rawResult = (message as SDKResultMessage & { result?: string }).result;
      if (typeof rawResult === 'string' && rawResult.trim()) {
        return rawResult.trim();
      }
    }

    if (assistantMessages.length > 0) {
      return assistantMessages.join('\n').trim();
    }

    return '';
  }

  /**
   * Get agent by session ID
   */
  getAgent(sessionId: string): Agent | null {
    return this.agents.get(sessionId) || null;
  }

  /**
   * List all active agents
   */
  listActive(): Agent[] {
    return Array.from(this.agents.values()).filter(agent => agent.status !== 'completed' && agent.status !== 'failed');
  }

  /**
   * Interrupt an agent
   */
  async interrupt(sessionId: string): Promise<void> {
    const agent = this.agents.get(sessionId);
    if (!agent) {
      throw new Error(`Agent ${sessionId} not found`);
    }

    agent.abortController.abort();
    await this.updateAgentStatus(sessionId, 'interrupted');
    await this.logger.log(sessionId, 'system', 'Agent interrupted');
  }

  /**
   * Wait for agent to complete
   */
  async wait(sessionId: string, maxWaitMs: number = DEFAULT_AGENT_TIMEOUT): Promise<void> {
    const agent = this.agents.get(sessionId);
    if (!agent) {
      throw new Error(`Agent ${sessionId} not found`);
    }

    // Return existing promise if already waiting
    if (this.waiters.has(sessionId)) {
      return this.waiters.get(sessionId);
    }

    // Create new wait promise
    const waitPromise = new Promise<void>((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const agent = this.agents.get(sessionId);
        if (!agent) {
          clearInterval(checkInterval);
          reject(new Error(`Agent ${sessionId} not found`));
          return;
        }

        if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'interrupted') {
          clearInterval(checkInterval);
          this.waiters.delete(sessionId);
          resolve();
          return;
        }

        if (Date.now() - startTime > maxWaitMs) {
          clearInterval(checkInterval);
          this.waiters.delete(sessionId);
          reject(new Error(`Agent wait timeout for ${sessionId}`));
          return;
        }
      }, 500);
    });

    this.waiters.set(sessionId, waitPromise);
    return waitPromise;
  }

  /**
   * Mark agent as completed
   */
  async completeAgent(sessionId: string, result: string): Promise<void> {
    const agent = this.agents.get(sessionId);
    if (!agent) {
      throw new Error(`Agent ${sessionId} not found`);
    }

    agent.status = 'completed';
    agent.completedAt = new Date();

    await this.updateAgentStatus(sessionId, 'completed');
    await this.sessionManager.updateSession(sessionId, {
      status: 'completed',
      result,
      completedAt: new Date(),
    });
    await this.logger.log(sessionId, 'system', 'Agent completed');
  }

  /**
   * Mark agent as failed
   */
  async failAgent(sessionId: string, error: string): Promise<void> {
    const agent = this.agents.get(sessionId);
    if (!agent) {
      throw new Error(`Agent ${sessionId} not found`);
    }

    agent.status = 'failed';
    agent.completedAt = new Date();

    await this.updateAgentStatus(sessionId, 'failed');
    await this.sessionManager.updateSession(sessionId, {
      status: 'failed',
      result: error,
      completedAt: new Date(),
    });
    await this.logger.log(sessionId, 'error', `Agent failed: ${error}`);
  }

  /**
   * Update agent status in database
   */
  private async updateAgentStatus(sessionId: string, status: AgentStatus): Promise<void> {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE active_agents
      SET status = ?, completed_at = ?
      WHERE session_id = ?
    `);

    const completedAt = status === 'completed' || status === 'failed' ? Date.now() : null;
    stmt.run(status, completedAt, sessionId);

    // Update in-memory agent
    const agent = this.agents.get(sessionId);
    if (agent) {
      agent.status = status;
    }
  }

  /**
   * Load active agents from database
   */
  async loadActiveAgents(): Promise<void> {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM active_agents
      WHERE status NOT IN ('completed', 'failed')
    `);

    const rows = stmt.all() as ActiveAgentRow[];

    for (const row of rows) {
      const agent = rowToAgent(row);
      this.agents.set(agent.sessionId, agent);
    }
  }

  /**
   * Get agent statistics
   */
  getStats(): {
    total: number;
    running: number;
    completed: number;
    failed: number;
  } {
    let total = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const agent of this.agents.values()) {
      total++;
      if (agent.status === 'running') running++;
      else if (agent.status === 'completed') completed++;
      else if (agent.status === 'failed') failed++;
    }

    return { total, running, completed, failed };
  }
}

export const createAgentManager = (sessionManager: ISessionManager, logger: ILogger, config: KlaudeConfig): IAgentManager => {
  return new AgentManager(sessionManager, logger, config);
};
