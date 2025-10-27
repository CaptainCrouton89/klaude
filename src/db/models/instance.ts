/**
 * Instance model - CRUD operations for instances table
 */

import { getDatabase } from '../database.js';
import type { Instance } from '@/types/db.js';

/**
 * Create a new instance record
 */
export function createInstance(
  instanceId: string,
  projectId: number,
  pid: number,
  tty?: string | null,
  metadataJson?: string | null
): Instance {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO instances (instance_id, project_id, pid, tty, metadata_json) VALUES (?, ?, ?, ?, ?)'
  );
  stmt.run(instanceId, projectId, pid, tty || null, metadataJson || null);

  return getInstanceById(instanceId)!;
}

/**
 * Get instance by ID
 */
export function getInstanceById(instanceId: string): Instance | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM instances WHERE instance_id = ?');
  const result = stmt.get(instanceId) as Instance | null;
  return result || null;
}

/**
 * Get all instances for a project
 */
export function getInstancesByProject(projectId: number): Instance[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM instances WHERE project_id = ? ORDER BY started_at DESC'
  );
  return stmt.all(projectId) as Instance[];
}

/**
 * Get active instances for a project (not ended)
 */
export function getActiveInstancesByProject(projectId: number): Instance[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM instances WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC'
  );
  return stmt.all(projectId) as Instance[];
}

/**
 * Mark an instance as ended
 */
export function markInstanceEnded(instanceId: string, exitCode: number | null): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE instances SET ended_at = CURRENT_TIMESTAMP, exit_code = ? WHERE instance_id = ?'
  );
  stmt.run(exitCode ?? null, instanceId);
}

/**
 * Update instance metadata
 */
export function updateInstanceMetadata(instanceId: string, metadataJson: string): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE instances SET metadata_json = ? WHERE instance_id = ?'
  );
  stmt.run(metadataJson, instanceId);
}

/**
 * Delete instance record
 */
export function deleteInstance(instanceId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM instances WHERE instance_id = ?');
  stmt.run(instanceId);
}
