import type { Session } from '@/types/db.js';
import { DatabaseError } from '@/utils/error-handler.js';
import { generateULID } from '@/utils/ulid.js';
import { getDatabase } from '../database.js';

type SessionStatus = Session['status'];

export interface CreateSessionOptions {
  parentId?: string | null;
  instanceId?: string | null;
  title?: string | null;
  prompt?: string | null;
  status?: SessionStatus;
  metadataJson?: string | null;
  sessionId?: string;
}

function mapRowToSession(row: unknown): Session {
  if (!row || typeof row !== 'object') {
    throw new DatabaseError('Invalid session row received from database');
  }
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    project_id: Number(record.project_id),
    parent_id: record.parent_id === null || record.parent_id === undefined ? null : String(record.parent_id),
    agent_type: record.agent_type as Session['agent_type'],
    instance_id:
      record.instance_id === null || record.instance_id === undefined
        ? null
        : String(record.instance_id),
    title: record.title === null || record.title === undefined ? null : String(record.title),
    prompt: record.prompt === null || record.prompt === undefined ? null : String(record.prompt),
    status: record.status as SessionStatus,
    created_at: String(record.created_at),
    updated_at: record.updated_at === null || record.updated_at === undefined ? null : String(record.updated_at),
    ended_at: record.ended_at === null || record.ended_at === undefined ? null : String(record.ended_at),
    last_claude_session_id:
      record.last_claude_session_id === null || record.last_claude_session_id === undefined
        ? null
        : String(record.last_claude_session_id),
    last_transcript_path:
      record.last_transcript_path === null || record.last_transcript_path === undefined
        ? null
        : String(record.last_transcript_path),
    current_process_pid:
      record.current_process_pid === null || record.current_process_pid === undefined
        ? null
        : Number(record.current_process_pid),
    metadata_json:
      record.metadata_json === null || record.metadata_json === undefined
        ? null
        : String(record.metadata_json),
  };
}

export function getSessionById(sessionId: string): Session | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM sessions
       WHERE id = ?`,
    );
    const row = stmt.get(sessionId);
    return row ? mapRowToSession(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to fetch session by id: ${message}`);
  }
}

export function listSessionsByProject(projectId: number): Session[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM sessions
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    );
    const rows = stmt.all(projectId) as unknown[];
    return rows.map(mapRowToSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list sessions for project: ${message}`);
  }
}

export function createSession(
  projectId: number,
  agentType: Session['agent_type'],
  options: CreateSessionOptions = {},
): Session {
  const sessionId = options.sessionId ?? generateULID();
  const status = options.status ?? 'active';

  try {
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT INTO sessions (
        id,
        project_id,
        parent_id,
        agent_type,
        instance_id,
        title,
        prompt,
        status,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      sessionId,
      projectId,
      options.parentId ?? null,
      agentType,
      options.instanceId ?? null,
      options.title ?? null,
      options.prompt ?? null,
      status,
      options.metadataJson ?? null,
    );

    const stmt = db.prepare(
      `SELECT *
       FROM sessions
       WHERE id = ?`,
    );
    const row = stmt.get(sessionId);
    if (!row) {
      throw new DatabaseError('Failed to retrieve newly created session');
    }
    return mapRowToSession(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to create session: ${message}`);
  }
}

export function updateSessionStatus(sessionId: string, status: SessionStatus): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE sessions
       SET status = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    stmt.run(status, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to update session status: ${message}`);
  }
}

export function updateSessionProcessPid(sessionId: string, pid: number | null): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE sessions
       SET current_process_pid = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    stmt.run(pid, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to update session process pid: ${message}`);
  }
}

export function markSessionEnded(sessionId: string, status: SessionStatus): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE sessions
       SET status = ?,
           ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    stmt.run(status, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to mark session ended: ${message}`);
  }
}

export function updateSessionClaudeLink(
  sessionId: string,
  claudeSessionId: string | null,
  transcriptPath: string | null,
): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE sessions
       SET last_claude_session_id = ?,
           last_transcript_path = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    stmt.run(claudeSessionId, transcriptPath, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to update session Claude link: ${message}`);
  }
}

export function getChildSessions(parentId: string): Session[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM sessions
       WHERE parent_id = ?
       ORDER BY created_at DESC`,
    );
    const rows = stmt.all(parentId) as unknown[];
    return rows.map(mapRowToSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to get child sessions: ${message}`);
  }
}

export function markSessionOrphaned(sessionId: string): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE sessions
       SET status = 'orphaned',
           ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    stmt.run(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to mark session orphaned: ${message}`);
  }
}

export function cascadeMarkSessionEnded(sessionId: string, status: SessionStatus): void {
  try {
    const db = getDatabase();

    // Get child sessions before marking parent as ended
    const children = getChildSessions(sessionId);

    // Mark the parent session as ended
    const parentStmt = db.prepare(
      `UPDATE sessions
       SET status = ?,
           ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    parentStmt.run(status, sessionId);

    // Mark all children as orphaned
    const orphanStmt = db.prepare(
      `UPDATE sessions
       SET status = 'orphaned',
           ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE parent_id = ?`,
    );
    orphanStmt.run(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to cascade mark session ended: ${message}`);
  }
}

/**
 * Calculate the depth of a session in the agent hierarchy.
 * Root sessions (parent_id = null) have depth 0.
 * Each child is one level deeper than its parent.
 */
export function calculateSessionDepth(sessionId: string): number {
  try {
    let depth = 0;
    let currentId: string | null = sessionId;

    // Traverse up the parent chain until we reach a root session
    while (currentId !== null) {
      const session = getSessionById(currentId);
      if (!session) {
        throw new DatabaseError(`Session ${currentId} not found while calculating depth`);
      }

      if (session.parent_id === null) {
        // Reached root session
        break;
      }

      depth++;
      currentId = session.parent_id;

      // Safety check: prevent infinite loops in case of circular references
      if (depth > 100) {
        throw new DatabaseError(`Depth calculation exceeded maximum (possible circular reference in session hierarchy)`);
      }
    }

    return depth;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to calculate session depth: ${message}`);
  }
}
