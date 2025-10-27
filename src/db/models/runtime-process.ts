/**
 * Runtime process model - CRUD operations for runtime_process table
 */

import { getDatabase } from '../database.js';
import type { RuntimeProcess } from '@/types/db.js';

/**
 * Create a new runtime process record
 */
export function createRuntimeProcess(
  klaudeSessionId: string,
  pid: number,
  kind: 'wrapper' | 'claude' | 'sdk',
  isCurrent: boolean = true
): RuntimeProcess {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO runtime_process (klaude_session_id, pid, kind, is_current) VALUES (?, ?, ?, ?)'
  );
  stmt.run(klaudeSessionId, pid, kind, isCurrent ? 1 : 0);

  // Get the inserted record
  const getStmt = db.prepare(
    'SELECT * FROM runtime_process WHERE klaude_session_id = ? ORDER BY started_at DESC LIMIT 1'
  );
  return getStmt.get(klaudeSessionId) as RuntimeProcess;
}

/**
 * Get runtime process by ID
 */
export function getRuntimeProcessById(id: number): RuntimeProcess | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM runtime_process WHERE id = ?');
  const result = stmt.get(id) as RuntimeProcess | null;
  return result || null;
}

/**
 * Get current runtime process for a session
 */
export function getCurrentRuntimeProcess(klaudeSessionId: string): RuntimeProcess | null {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM runtime_process WHERE klaude_session_id = ? AND is_current = 1'
  );
  const result = stmt.get(klaudeSessionId) as RuntimeProcess | null;
  return result || null;
}

/**
 * Get all runtime processes for a session
 */
export function getRuntimeProcessesBySession(klaudeSessionId: string): RuntimeProcess[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM runtime_process WHERE klaude_session_id = ? ORDER BY started_at DESC'
  );
  return stmt.all(klaudeSessionId) as RuntimeProcess[];
}

/**
 * Mark runtime process as exited
 */
export function markRuntimeExited(id: number, exitCode: number): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE runtime_process SET exited_at = CURRENT_TIMESTAMP, exit_code = ? WHERE id = ?'
  );
  stmt.run(exitCode, id);
}

/**
 * Mark a process as no longer current
 */
export function markProcessNotCurrent(id: number): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE runtime_process SET is_current = 0 WHERE id = ?'
  );
  stmt.run(id);
}

/**
 * Mark all processes for a session as not current
 */
export function markAllProcessesNotCurrent(klaudeSessionId: string): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE runtime_process SET is_current = 0 WHERE klaude_session_id = ?'
  );
  stmt.run(klaudeSessionId);
}

/**
 * Delete runtime process record
 */
export function deleteRuntimeProcess(id: number): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM runtime_process WHERE id = ?');
  stmt.run(id);
}
