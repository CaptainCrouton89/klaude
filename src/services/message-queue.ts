/**
 * Inter-agent message queue system
 *
 * Uses signal-based notification (SIGUSR1) for instant message delivery.
 * Messages persist in SQLite for durability and offline access.
 */

import { getDatabase } from '@/db/database.js';
import { IMessageQueue, Message } from '@/types/index.js';
import { randomBytes } from 'crypto';

/**
 * Database row interface for messages table
 */
interface MessageRow {
  id: string;
  from_session_id: string;
  to_session_id: string;
  content: string;
  created_at: number;
  read_at: number | null;
}

function generateMessageId(): string {
  return randomBytes(6).toString('hex');
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    fromSessionId: row.from_session_id,
    toSessionId: row.to_session_id,
    content: row.content,
    createdAt: new Date(row.created_at),
    readAt: row.read_at ? new Date(row.read_at) : undefined,
  };
}

/**
 * Helper to find the process ID for a given session
 */
function getSessionProcessId(sessionId: string): number | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT process_id FROM sessions WHERE id = ?
    `);
    const result = stmt.get(sessionId) as { process_id: number } | undefined;
    return result?.process_id ?? null;
  } catch (error) {
    // Database query failed; session may not exist or db unavailable
    // Return null to skip signal delivery (message will be available on dequeue)
    return null;
  }
}

/**
 * Message Queue implementation using database with signal-based notifications
 */
export class MessageQueue implements IMessageQueue {
  /**
   * Enqueue a message from one session to another
   * Sends SIGUSR1 signal to target process for instant notification
   */
  async enqueue(fromSessionId: string, toSessionId: string, content: string): Promise<Message> {
    const db = getDatabase();
    const messageId = generateMessageId();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO messages (id, from_session_id, to_session_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(messageId, fromSessionId, toSessionId, content, now);

    // Signal the target process immediately
    const targetPid = getSessionProcessId(toSessionId);
    if (targetPid) {
      try {
        process.kill(targetPid, 'SIGUSR1');
      } catch (error) {
        // Only ignore ESRCH (process doesn't exist) - message will be dequeued later
        if (!(error instanceof Error)) {
          throw error;
        }
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ESRCH') {
          throw nodeError;
        }
      }
    }

    return {
      id: messageId,
      fromSessionId,
      toSessionId,
      content,
      createdAt: new Date(now),
    };
  }

  /**
   * Dequeue all unread messages for a session
   */
  async dequeue(sessionId: string): Promise<Message[]> {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM messages
      WHERE to_session_id = ? AND read_at IS NULL
      ORDER BY created_at ASC
    `);

    const rows = stmt.all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Mark message as read/acknowledged
   */
  async ack(messageId: string): Promise<void> {
    const db = getDatabase();
    const now = Date.now();

    const stmt = db.prepare(`
      UPDATE messages SET read_at = ? WHERE id = ?
    `);

    stmt.run(now, messageId);
  }
}

export const createMessageQueue = (): IMessageQueue => {
  return new MessageQueue();
};
