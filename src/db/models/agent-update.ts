import type { AgentUpdate } from '@/types/db.js';
import { DatabaseError } from '@/utils/error-handler.js';
import { getDatabase, initializeDatabase } from '../database.js';

function mapRowToAgentUpdate(row: unknown): AgentUpdate {
  if (!row || typeof row !== 'object') {
    throw new DatabaseError('Invalid agent update row received from database');
  }
  const record = row as Record<string, unknown>;
  return {
    id: Number(record.id),
    session_id: String(record.session_id),
    parent_session_id:
      record.parent_session_id === null || record.parent_session_id === undefined
        ? null
        : String(record.parent_session_id),
    update_text: String(record.update_text),
    acknowledged: Boolean(record.acknowledged),
    created_at: String(record.created_at),
  };
}

export async function createAgentUpdate(
  sessionId: string,
  parentSessionId: string | null,
  updateText: string,
): Promise<AgentUpdate> {
  try {
    // Ensure database is initialized
    await initializeDatabase();

    const db = getDatabase();
    const insertWithReturn = db.prepare(
      `INSERT INTO agent_updates (session_id, parent_session_id, update_text)
       VALUES (?, ?, ?)
       RETURNING *`,
    );
    const row = insertWithReturn.get(sessionId, parentSessionId ?? null, updateText);
    if (!row) {
      throw new DatabaseError('Failed to retrieve newly created agent update');
    }
    return mapRowToAgentUpdate(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to create agent update: ${message}`);
  }
}

export function listPendingUpdatesByParent(parentSessionId: string): AgentUpdate[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM agent_updates
       WHERE parent_session_id = ? AND acknowledged = 0
       ORDER BY created_at ASC`,
    );
    const rows = stmt.all(parentSessionId) as unknown[];
    return rows.map(mapRowToAgentUpdate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list pending updates for parent: ${message}`);
  }
}

export function listUpdatesBySession(sessionId: string): AgentUpdate[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM agent_updates
       WHERE session_id = ?
       ORDER BY created_at DESC`,
    );
    const rows = stmt.all(sessionId) as unknown[];
    return rows.map(mapRowToAgentUpdate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list updates for session: ${message}`);
  }
}

export function markUpdateAcknowledged(updateId: number): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE agent_updates
       SET acknowledged = 1
       WHERE id = ?`,
    );
    stmt.run(updateId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to mark update acknowledged: ${message}`);
  }
}

export function getAgentUpdateById(updateId: number): AgentUpdate | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM agent_updates
       WHERE id = ?`,
    );
    const row = stmt.get(updateId);
    return row ? mapRowToAgentUpdate(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to fetch agent update by id: ${message}`);
  }
}
