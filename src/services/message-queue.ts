/**
 * Inter-agent message queue system
 */

import { IMessageQueue, Message } from '@/types/index.js';
import { getDatabase } from '@/db/database.js';
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
 * Message Queue implementation using database
 */
export class MessageQueue implements IMessageQueue {
  private subscribers: Map<string, Set<(message: Message) => void>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 1000;

  constructor() {
    this.startPolling();
  }

  /**
   * Enqueue a message from one session to another
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
   * Subscribe to messages for a session
   */
  subscribe(sessionId: string, callback: (message: Message) => void): void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);
  }

  /**
   * Unsubscribe from messages for a session
   */
  unsubscribe(sessionId: string, callback: (message: Message) => void): void {
    if (this.subscribers.has(sessionId)) {
      this.subscribers.get(sessionId)!.delete(callback);
      if (this.subscribers.get(sessionId)!.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
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

  /**
   * Start polling for new messages
   */
  private startPolling(): void {
    this.pollInterval = setInterval(async () => {
      const sessionIds = Array.from(this.subscribers.keys());

      for (const sessionId of sessionIds) {
        try {
          const messages = await this.dequeue(sessionId);

          if (messages.length > 0) {
            const callbacks = this.subscribers.get(sessionId);
            if (callbacks) {
              for (const message of messages) {
                for (const callback of callbacks) {
                  callback(message);
                }
                // Auto-acknowledge after callbacks
                await this.ack(message.id);
              }
            }
          }
        } catch (error) {
          console.error(`Error polling messages for session ${sessionId}:`, error);
        }
      }
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stop polling for messages
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Get all unread message count for a session
   */
  async getUnreadCount(sessionId: string): Promise<number> {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE to_session_id = ? AND read_at IS NULL
    `);

    const result = stmt.get(sessionId) as { count: number };
    return result.count;
  }

  /**
   * Clear old messages (older than 24 hours)
   */
  async clearOldMessages(maxAgeMs: number): Promise<number> {
    const db = getDatabase();
    const cutoffTime = Date.now() - maxAgeMs;

    const stmt = db.prepare(`
      DELETE FROM messages WHERE created_at < ?
    `);

    const result = stmt.run(cutoffTime);
    return result.changes;
  }
}

export const createMessageQueue = (): IMessageQueue => {
  return new MessageQueue();
};
