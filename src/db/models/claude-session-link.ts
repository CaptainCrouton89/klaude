/**
 * Claude session link model - CRUD operations for claude_session_links table
 */

import { getDatabase } from '../database.js';
import type { ClaudeSessionLink } from '@/types/db.js';

/**
 * Create a new Claude session link
 */
export function createClaudeSessionLink(
  klaudeSessionId: string,
  claudeSessionId: string,
  transcriptPath?: string | null,
  source?: string | null
): ClaudeSessionLink {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO claude_session_links (klaude_session_id, claude_session_id, transcript_path, source) VALUES (?, ?, ?, ?)'
  );
  stmt.run(klaudeSessionId, claudeSessionId, transcriptPath || null, source || null);

  return getClaudeSessionLinkByClaudeId(claudeSessionId)!;
}

/**
 * Get Claude session link by Claude session ID
 */
export function getClaudeSessionLinkByClaudeId(claudeSessionId: string): ClaudeSessionLink | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM claude_session_links WHERE claude_session_id = ?');
  const result = stmt.get(claudeSessionId) as ClaudeSessionLink | null;
  return result || null;
}

/**
 * Get all Claude session links for a Klaude session
 */
export function getClaudeSessionLinksByKlaudeId(klaudeSessionId: string): ClaudeSessionLink[] {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM claude_session_links WHERE klaude_session_id = ? ORDER BY started_at DESC'
  );
  return stmt.all(klaudeSessionId) as ClaudeSessionLink[];
}

/**
 * Get most recent Claude session link for a Klaude session
 */
export function getLatestClaudeSessionLink(klaudeSessionId: string): ClaudeSessionLink | null {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT * FROM claude_session_links WHERE klaude_session_id = ? ORDER BY started_at DESC LIMIT 1'
  );
  const result = stmt.get(klaudeSessionId) as ClaudeSessionLink | null;
  return result || null;
}

/**
 * Mark a Claude session link as ended
 */
export function markClaudeSessionEnded(claudeSessionId: string): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE claude_session_links SET ended_at = CURRENT_TIMESTAMP WHERE claude_session_id = ?'
  );
  stmt.run(claudeSessionId);
}

/**
 * Update transcript path for a Claude session link
 */
export function updateClaudeSessionTranscript(claudeSessionId: string, transcriptPath: string): void {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE claude_session_links SET transcript_path = ? WHERE claude_session_id = ?'
  );
  stmt.run(transcriptPath, claudeSessionId);
}

/**
 * Delete Claude session link
 */
export function deleteClaudeSessionLink(claudeSessionId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM claude_session_links WHERE claude_session_id = ?');
  stmt.run(claudeSessionId);
}
