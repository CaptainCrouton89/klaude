/**
 * Session model - CRUD operations for sessions table
 */

import { getDatabase } from '../database.js';
import type { Session } from '@/types/db.js';
import { generateULID } from '@/utils/ulid.js';

/**
 * Create a new session
 */
export interface CreateSessionOptions {
  instanceId?: string | null;
  parentId?: string | null;
  title?: string | null;
  prompt?: string | null;
  metadataJson?: string | null;
  sessionId?: string;
}

export function createSession(
  projectId: number,
  agentType: 'tui' | 'sdk' | 'worker',
  options: CreateSessionOptions = {},
): Session {
  const db = getDatabase();
  const {
    instanceId = null,
    parentId = null,
    title = null,
    prompt = null,
    metadataJson = null,
    sessionId,
  } = options;

  const id = sessionId ?? generateULID();

  const stmt = db.prepare(
    'INSERT INTO sessions (id, project_id, agent_type, instance_id, parent_id, title, prompt, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    id,
    projectId,
    agentType,
    instanceId || null,
    parentId || null,
    title || null,
    prompt || null,
    metadataJson || null,
  );

  return getSessionById(id)!;
}

/**
 * Get session by ID
 */
export function getSessionById(id: string): Session | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const result = stmt.get(id) as Session | null;
  return result || null;
}

/**
 * Get all sessions for a project
 */
export function getSessionsByProject(projectId: number): Session[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(projectId) as Session[];
}

/**
 * Get active sessions for a project (status = 'active' or 'running')
 */
export function getActiveSessionsByProject(projectId: number): Session[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM sessions WHERE project_id = ? AND (status = ? OR status = ?) ORDER BY created_at DESC'
  );
  return stmt.all(projectId, 'active', 'running') as Session[];
}

/**
 * Get all sessions for an instance
 */
export function getSessionsByInstance(instanceId: string): Session[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM sessions WHERE instance_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(instanceId) as Session[];
}

/**
 * Get root session for a project (no parent)
 */
export function getRootSessionByProject(projectId: number): Session | null {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM sessions WHERE project_id = ? AND parent_id IS NULL LIMIT 1'
  );
  const result = stmt.get(projectId) as Session | null;
  return result || null;
}

/**
 * Get child sessions of a session
 */
export function getChildSessions(parentId: string): Session[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(parentId) as Session[];
}

/**
 * Update session Claude session info (claude_session_id and transcript_path)
 */
export function updateSessionClaudeInfo(
  id: string,
  claudeSessionId: string,
  transcriptPath: string
): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE sessions SET last_claude_session_id = ?, last_transcript_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  stmt.run(claudeSessionId, transcriptPath, id);
}

/**
 * Update session status
 */
export function updateSessionStatus(id: string, status: 'active' | 'running' | 'done' | 'failed' | 'interrupted'): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  stmt.run(status, id);
}

/**
 * Update session current process PID
 */
export function updateSessionProcessPid(id: string, pid: number | null): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE sessions SET current_process_pid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  stmt.run(pid || null, id);
}

/**
 * Mark session as ended
 */
export function markSessionEnded(id: string, status: 'done' | 'failed' | 'interrupted' = 'done'): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE sessions SET status = ?, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  stmt.run(status, id);
}

/**
 * Update session metadata
 */
export function updateSessionMetadata(id: string, metadataJson: string): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE sessions SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  stmt.run(metadataJson, id);
}

/**
 * Delete session
 */
export function deleteSession(id: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  stmt.run(id);
}
