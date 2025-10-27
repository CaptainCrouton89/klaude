import type { ClaudeSessionLink } from '@/types/db.js';
import { DatabaseError } from '@/utils/error-handler.js';
import { getDatabase } from '../database.js';

function mapRowToLink(row: unknown): ClaudeSessionLink {
  if (!row || typeof row !== 'object') {
    throw new DatabaseError('Invalid Claude session link row received from database');
  }
  const record = row as Record<string, unknown>;
  return {
    id: Number(record.id),
    klaude_session_id: String(record.klaude_session_id),
    claude_session_id: String(record.claude_session_id),
    transcript_path:
      record.transcript_path === null || record.transcript_path === undefined
        ? null
        : String(record.transcript_path),
    source: record.source === null || record.source === undefined ? null : String(record.source),
    started_at: String(record.started_at),
    ended_at: record.ended_at === null || record.ended_at === undefined ? null : String(record.ended_at),
  };
}

export interface CreateClaudeSessionLinkOptions {
  transcriptPath?: string | null;
  source?: string | null;
}

export function createClaudeSessionLink(
  klaudeSessionId: string,
  claudeSessionId: string,
  options: CreateClaudeSessionLinkOptions = {},
): ClaudeSessionLink {
  try {
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT INTO claude_session_links (
        klaude_session_id,
        claude_session_id,
        transcript_path,
        source
      ) VALUES (?, ?, ?, ?)`,
    );
    insert.run(
      klaudeSessionId,
      claudeSessionId,
      options.transcriptPath ?? null,
      options.source ?? null,
    );

    const stmt = db.prepare(
      `SELECT *
       FROM claude_session_links
       WHERE claude_session_id = ?`,
    );
    const row = stmt.get(claudeSessionId);
    if (!row) {
      throw new DatabaseError('Failed to retrieve newly created Claude session link');
    }
    return mapRowToLink(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to create Claude session link: ${message}`);
  }
}

export function getClaudeSessionLink(claudeSessionId: string): ClaudeSessionLink | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM claude_session_links
       WHERE claude_session_id = ?`,
    );
    const row = stmt.get(claudeSessionId);
    return row ? mapRowToLink(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to fetch Claude session link: ${message}`);
  }
}

export function listClaudeSessionLinks(klaudeSessionId: string): ClaudeSessionLink[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT *
       FROM claude_session_links
       WHERE klaude_session_id = ?
       ORDER BY started_at DESC`,
    );
    const rows = stmt.all(klaudeSessionId) as unknown[];
    return rows.map(mapRowToLink);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list Claude session links: ${message}`);
  }
}

export function markClaudeSessionEnded(claudeSessionId: string): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `UPDATE claude_session_links
       SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
       WHERE claude_session_id = ?`,
    );
    stmt.run(claudeSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to mark Claude session ended: ${message}`);
  }
}
