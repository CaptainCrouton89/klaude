/**
 * Session management service
 */

import { Session, ISessionManager, AgentType, SessionStatus } from '@/types/index.js';
import { getDatabase } from '@/db/database.js';
import { randomBytes } from 'crypto';
import { SESSION_ID_LENGTH } from '@/config/constants.js';

/**
 * Database row interface for sessions table
 */
interface SessionRow {
  id: string;
  claude_session_id: string | null;
  agent_type: string;
  parent_session_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  status: string;
  prompt: string;
  result: string | null;
  metadata: string | null;
}

function generateSessionId(): string {
  return randomBytes(SESSION_ID_LENGTH / 2).toString('hex');
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    claudeSessionId: row.claude_session_id || undefined,
    agentType: row.agent_type as AgentType,
    parentSessionId: row.parent_session_id || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    status: row.status as SessionStatus,
    prompt: row.prompt,
    result: row.result || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  };
}

/**
 * Session Manager implementation
 */
export class SessionManager implements ISessionManager {
  /**
   * Create a new session for an agent
   */
  async createSession(agentType: AgentType, prompt: string, parentSessionId?: string): Promise<Session> {
    const db = getDatabase();
    const sessionId = generateSessionId();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO sessions (id, claude_session_id, agent_type, parent_session_id, created_at, updated_at, status, prompt, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(sessionId, null, agentType, parentSessionId || null, now, now, 'created', prompt, '{}');

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Failed to create session ${sessionId}`);
    }

    return session;
  }

  /**
   * Retrieve a session by ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  /**
   * Retrieve a session by Claude session ID
   */
  async getSessionByClaudeId(claudeSessionId: string): Promise<Session | null> {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
    const row = stmt.get(claudeSessionId) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  /**
   * Update session properties
   */
  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    const db = getDatabase();
    const now = Date.now();

    const updateFields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.claudeSessionId !== undefined) {
      updateFields.push('claude_session_id = ?');
      values.push(updates.claudeSessionId);
    }
    if (updates.parentSessionId !== undefined) {
      updateFields.push('parent_session_id = ?');
      values.push(updates.parentSessionId ?? null);
    }
    if (updates.result !== undefined) {
      updateFields.push('result = ?');
      values.push(updates.result);
    }
    if (updates.completedAt !== undefined) {
      updateFields.push('completed_at = ?');
      values.push(updates.completedAt.getTime());
    }
    if (updates.metadata !== undefined) {
      updateFields.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }

    // Always update updated_at
    updateFields.push('updated_at = ?');
    values.push(now);

    values.push(sessionId);

    const stmt = db.prepare(`
      UPDATE sessions
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `);

    stmt.run(...values);
  }

  /**
   * Close a session with a result
   */
  async closeSession(sessionId: string, result: string): Promise<void> {
    await this.updateSession(sessionId, {
      status: 'completed',
      result,
      completedAt: new Date(),
    });
  }

  /**
   * List sessions with optional filtering
   */
  async listSessions(filter?: Partial<Session>): Promise<Session[]> {
    const db = getDatabase();
    let query = 'SELECT * FROM sessions WHERE 1=1';
    const values: unknown[] = [];

    if (filter?.agentType) {
      query += ' AND agent_type = ?';
      values.push(filter.agentType);
    }
    if (filter?.status) {
      query += ' AND status = ?';
      values.push(filter.status);
    }
    if (filter?.parentSessionId) {
      query += ' AND parent_session_id = ?';
      values.push(filter.parentSessionId);
    }
    if (filter?.claudeSessionId) {
      query += ' AND claude_session_id = ?';
      values.push(filter.claudeSessionId);
    }

    query += ' ORDER BY updated_at DESC';

    const stmt = db.prepare(query);
    const rows = stmt.all(...values) as SessionRow[];

    return rows.map(rowToSession);
  }

  /**
   * Activate/set active session
   */
  async activateSession(sessionId: string): Promise<void> {
    // This would typically store the active session in a config file
    // For now, we'll just verify it exists
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Store in a simple file: ~/.klaude/.active-session
    // This will be used to restore context
    const fs = await import('fs').then(m => m.promises);
    const path = await import('path').then(m => m.default);
    const { getKlaudeHome } = await import('@/utils/path-helper.js').then(m => m);

    const activeSessionFile = path.join(getKlaudeHome(), '.active-session');
    await fs.writeFile(activeSessionFile, sessionId, 'utf-8');
  }

  /**
   * Get the currently active session ID
   */
  async getActiveSessionId(): Promise<string | null> {
    try {
      const fs = await import('fs').then(m => m.promises);
      const path = await import('path').then(m => m.default);
      const { getKlaudeHome } = await import('@/utils/path-helper.js').then(m => m);

      const activeSessionFile = path.join(getKlaudeHome(), '.active-session');
      const sessionId = await fs.readFile(activeSessionFile, 'utf-8');
      return sessionId.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get session parent chain (ancestors)
   */
  async getParentChain(sessionId: string): Promise<Session[]> {
    const chain: Session[] = [];
    let current = await this.getSession(sessionId);

    while (current) {
      chain.unshift(current);
      if (current.parentSessionId) {
        current = await this.getSession(current.parentSessionId);
      } else {
        break;
      }
    }

    return chain;
  }
}

export const createSessionManager = (): ISessionManager => {
  return new SessionManager();
};
