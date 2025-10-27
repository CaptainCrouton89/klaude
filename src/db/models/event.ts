/**
 * Event model - CRUD operations for events table
 */

import { getDatabase } from '../database.js';
import type { Event } from '@/types/db.js';

/**
 * Create a new event
 */
export function createEvent(
  kind: string,
  projectId?: number | null,
  klaudeSessionId?: string | null,
  payloadJson?: string | null
): Event {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO events (kind, project_id, klaude_session_id, payload_json) VALUES (?, ?, ?, ?)'
  );
  stmt.run(kind, projectId || null, klaudeSessionId || null, payloadJson || null);

  // Get the inserted event
  const getStmt = db.prepare(
    'SELECT * FROM events ORDER BY id DESC LIMIT 1'
  );
  return getStmt.get() as Event;
}

/**
 * Get event by ID
 */
export function getEventById(id: number): Event | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const result = stmt.get(id) as Event | null;
  return result || null;
}

/**
 * Get events by project
 */
export function getEventsByProject(projectId: number, limit: number = 100, offset: number = 0): Event[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  );
  return stmt.all(projectId, limit, offset) as Event[];
}

/**
 * Get events by session
 */
export function getEventsBySession(klaudeSessionId: string, limit: number = 100, offset: number = 0): Event[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM events WHERE klaude_session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  );
  return stmt.all(klaudeSessionId, limit, offset) as Event[];
}

/**
 * Get events by kind
 */
export function getEventsByKind(kind: string, limit: number = 100): Event[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM events WHERE kind = ? ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(kind, limit) as Event[];
}

/**
 * Get recent events
 */
export function getRecentEvents(limit: number = 100): Event[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM events ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(limit) as Event[];
}

/**
 * Count events by project
 */
export function countEventsByProject(projectId: number): number {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT COUNT(*) as count FROM events WHERE project_id = ?'
  );
  const result = stmt.get(projectId) as { count: number };
  return result.count;
}

/**
 * Count events by session
 */
export function countEventsBySession(klaudeSessionId: string): number {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT COUNT(*) as count FROM events WHERE klaude_session_id = ?'
  );
  const result = stmt.get(klaudeSessionId) as { count: number };
  return result.count;
}

/**
 * Delete events by project (cascading)
 */
export function deleteEventsByProject(projectId: number): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM events WHERE project_id = ?');
  stmt.run(projectId);
}

/**
 * Delete events by session
 */
export function deleteEventsBySession(klaudeSessionId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM events WHERE klaude_session_id = ?');
  stmt.run(klaudeSessionId);
}
