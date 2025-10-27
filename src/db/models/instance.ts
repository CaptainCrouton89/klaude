import type { Instance } from '@/types/db.js';
import { DatabaseError } from '@/utils/error-handler.js';
import { getDatabase } from '../database.js';

function mapRowToInstance(row: unknown): Instance {
  if (!row || typeof row !== 'object') {
    throw new DatabaseError('Invalid instance row received from database');
  }
  const record = row as Record<string, unknown>;
  return {
    instance_id: String(record.instance_id),
    project_id: Number(record.project_id),
    pid: Number(record.pid),
    tty: record.tty === null || record.tty === undefined ? null : String(record.tty),
    started_at: String(record.started_at),
    ended_at: record.ended_at === null || record.ended_at === undefined ? null : String(record.ended_at),
    exit_code:
      record.exit_code === null || record.exit_code === undefined
        ? null
        : Number(record.exit_code),
    metadata_json:
      record.metadata_json === null || record.metadata_json === undefined
        ? null
        : String(record.metadata_json),
  };
}

export function getInstanceById(instanceId: string): Instance | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT instance_id, project_id, pid, tty, started_at, ended_at, exit_code, metadata_json
       FROM instances
       WHERE instance_id = ?`,
    );
    const row = stmt.get(instanceId);
    return row ? mapRowToInstance(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to fetch instance by id: ${message}`);
  }
}

export function listInstancesByProject(projectId: number): Instance[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT instance_id, project_id, pid, tty, started_at, ended_at, exit_code, metadata_json
       FROM instances
       WHERE project_id = ?
       ORDER BY started_at DESC`,
    );
    const rows = stmt.all(projectId) as unknown[];
    return rows.map(mapRowToInstance);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list project instances: ${message}`);
  }
}

export function createInstance(
  instanceId: string,
  projectId: number,
  pid: number,
  tty: string | null,
  metadataJson: string | null = null,
): Instance {
  try {
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT INTO instances (instance_id, project_id, pid, tty, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(instanceId, projectId, pid, tty, metadataJson);

    const stmt = db.prepare(
      `SELECT instance_id, project_id, pid, tty, started_at, ended_at, exit_code, metadata_json
       FROM instances
       WHERE instance_id = ?`,
    );
    const row = stmt.get(instanceId);
    if (!row) {
      throw new DatabaseError('Failed to retrieve newly created instance');
    }
    return mapRowToInstance(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to create instance: ${message}`);
  }
}

export function markInstanceEnded(instanceId: string, exitCode: number | null): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE instances
       SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
           exit_code = ?
       WHERE instance_id = ?`,
    );
    stmt.run(exitCode, instanceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to mark instance ended: ${message}`);
  }
}
