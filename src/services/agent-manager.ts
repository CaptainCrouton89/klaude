/**
 * Agent spawning and management system
 */

import { IAgentManager, Agent, AgentType, AgentStatus, StartAgentOptions, ISessionManager, ILogger } from '@/types/index.js';
import { getDatabase } from '@/db/database.js';
import { DEFAULT_AGENT_TIMEOUT } from '@/config/constants.js';

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

  constructor(sessionManager: ISessionManager, logger: ILogger) {
    this.sessionManager = sessionManager;
    this.logger = logger;
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

    return agent;
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

export const createAgentManager = (sessionManager: ISessionManager, logger: ILogger): IAgentManager => {
  return new AgentManager(sessionManager, logger);
};
