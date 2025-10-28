import type { Event } from '@/types/db.js';
import { DatabaseError } from '@/utils/error-handler.js';
import { getDatabase } from '../database.js';

function mapRowToEvent(row: unknown): Event {
  if (!row || typeof row !== 'object') {
    throw new DatabaseError('Invalid event row received from database');
  }
  const record = row as Record<string, unknown>;
  return {
    id: Number(record.id),
    project_id:
      record.project_id === null || record.project_id === undefined
        ? null
        : Number(record.project_id),
    klaude_session_id:
      record.klaude_session_id === null || record.klaude_session_id === undefined
        ? null
        : String(record.klaude_session_id),
    kind: String(record.kind),
    payload_json:
      record.payload_json === null || record.payload_json === undefined
        ? null
        : String(record.payload_json),
    created_at: String(record.created_at),
  };
}

export function createEvent(
  kind: string,
  projectId: number | null,
  sessionId: string | null,
  payloadJson: string | null = null,
): Event {
  try {
    const db = getDatabase();
    const insertWithReturn = db.prepare(
      `INSERT INTO events (project_id, klaude_session_id, kind, payload_json)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    );
    const row = insertWithReturn.get(projectId ?? null, sessionId ?? null, kind, payloadJson ?? null);
    if (!row) {
      throw new DatabaseError('Failed to retrieve newly created event');
    }
    return mapRowToEvent(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to create event: ${message}`);
  }
}

export function listEventsByProject(projectId: number): Event[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM events
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    );
    const rows = stmt.all(projectId) as unknown[];
    return rows.map(mapRowToEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list events for project: ${message}`);
  }
}

export function listEventsBySession(sessionId: string): Event[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM events
       WHERE klaude_session_id = ?
       ORDER BY created_at DESC`,
    );
    const rows = stmt.all(sessionId) as unknown[];
    return rows.map(mapRowToEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list events for session: ${message}`);
  }
}
