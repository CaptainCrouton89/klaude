import type { RuntimeProcess } from '@/types/db.js';
import { DatabaseError } from '@/utils/error-handler.js';
import { getDatabase } from '../database.js';

type RuntimeProcessKind = RuntimeProcess['kind'];

function mapRowToRuntimeProcess(row: unknown): RuntimeProcess {
  if (!row || typeof row !== 'object') {
    throw new DatabaseError('Invalid runtime process row received from database');
  }
  const record = row as Record<string, unknown>;
  return {
    id: Number(record.id),
    klaude_session_id: String(record.klaude_session_id),
    pid: Number(record.pid),
    kind: record.kind as RuntimeProcessKind,
    started_at: String(record.started_at),
    exited_at: record.exited_at === null || record.exited_at === undefined ? null : String(record.exited_at),
    exit_code:
      record.exit_code === null || record.exit_code === undefined
        ? null
        : Number(record.exit_code),
    is_current: Number(record.is_current) === 1 ? 1 : 0,
  };
}

export function getRuntimeProcessById(id: number): RuntimeProcess | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM runtime_process
       WHERE id = ?`,
    );
    const row = stmt.get(id);
    return row ? mapRowToRuntimeProcess(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to fetch runtime process: ${message}`);
  }
}

export function listRuntimeProcessesForSession(sessionId: string): RuntimeProcess[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM runtime_process
       WHERE klaude_session_id = ?
       ORDER BY started_at DESC`,
    );
    const rows = stmt.all(sessionId) as unknown[];
    return rows.map(mapRowToRuntimeProcess);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list runtime processes: ${message}`);
  }
}

export function clearCurrentRuntimeProcesses(sessionId: string): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE runtime_process
       SET is_current = 0
       WHERE klaude_session_id = ?`,
    );
    stmt.run(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to clear current runtime processes: ${message}`);
  }
}

export function createRuntimeProcess(
  sessionId: string,
  pid: number,
  kind: RuntimeProcessKind,
  isCurrent: boolean,
): RuntimeProcess {
  try {
    const db = getDatabase();

    if (isCurrent) {
      clearCurrentRuntimeProcesses(sessionId);
    }

    const insertWithReturn = db.prepare(
      `INSERT INTO runtime_process (klaude_session_id, pid, kind, is_current)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    );
    const row = insertWithReturn.get(sessionId, pid, kind, isCurrent ? 1 : 0);
    if (!row) {
      throw new DatabaseError('Failed to retrieve newly created runtime process');
    }
    return mapRowToRuntimeProcess(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to create runtime process: ${message}`);
  }
}

export function markRuntimeExited(runtimeProcessId: number, exitCode: number): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE runtime_process
       SET exited_at = COALESCE(exited_at, CURRENT_TIMESTAMP),
           exit_code = ?,
           is_current = 0
       WHERE id = ?`,
    );
    stmt.run(exitCode, runtimeProcessId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to mark runtime process exited: ${message}`);
  }
}
