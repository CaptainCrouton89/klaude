/**
 * File-based session logger
 */

import { ILogger, LogEntry, LogEntryType } from '@/types/index.js';
import { getLogsDir, getSessionLogPath } from '@/utils/path-helper.js';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * Logger implementation that stores logs to files
 */
export class FileLogger implements ILogger {
  private logBuffers: Map<string, LogEntry[]> = new Map();
  private flushTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly FLUSH_INTERVAL = 1000; // 1 second

  constructor() {
    // Ensure logs directory exists
    const logsDir = getLogsDir();
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
  }

  /**
   * Log an entry for a session
   */
  async log(sessionId: string, type: LogEntryType, content: string): Promise<void> {
    const entry: LogEntry = {
      timestamp: new Date(),
      sessionId,
      type,
      content,
    };

    // Add to buffer
    if (!this.logBuffers.has(sessionId)) {
      this.logBuffers.set(sessionId, []);
    }
    this.logBuffers.get(sessionId)!.push(entry);

    // Schedule flush
    this.scheduleFlush(sessionId);
  }

  /**
   * Get all log entries for a session
   */
  async stream(sessionId: string): Promise<LogEntry[]> {
    // Flush any pending entries first
    await this.flush(sessionId);

    const logPath = getSessionLogPath(sessionId);
    if (!existsSync(logPath)) {
      return [];
    }

    const content = await fs.readFile(logPath, 'utf-8');
    if (!content.trim()) {
      return [];
    }

    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          // If a line is not valid JSON, skip it
          return null;
        }
      })
      .filter((entry): entry is LogEntry => entry !== null);
  }

  /**
   * Flush buffered logs to disk
   */
  async flush(sessionId: string): Promise<void> {
    const buffer = this.logBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) {
      return;
    }

    const logPath = getSessionLogPath(sessionId);
    const logDir = path.dirname(logPath);

    // Ensure directory exists
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Write entries as newline-delimited JSON
    const content = buffer
      .map(entry => JSON.stringify(entry))
      .join('\n') + '\n';

    try {
      await fs.appendFile(logPath, content, 'utf-8');
      this.logBuffers.delete(sessionId);

      // Clear any pending timer
      if (this.flushTimers.has(sessionId)) {
        clearTimeout(this.flushTimers.get(sessionId)!);
        this.flushTimers.delete(sessionId);
      }
    } catch (error) {
      console.error(`Failed to flush logs for session ${sessionId}:`, error);
    }
  }

  /**
   * Schedule a flush for a session
   */
  private scheduleFlush(sessionId: string): void {
    // Clear existing timer
    if (this.flushTimers.has(sessionId)) {
      clearTimeout(this.flushTimers.get(sessionId)!);
    }

    // Schedule new flush
    const timer = setTimeout(() => {
      this.flush(sessionId).catch(err => {
        console.error(`Error flushing logs for ${sessionId}:`, err);
      });
    }, this.FLUSH_INTERVAL);

    this.flushTimers.set(sessionId, timer);
  }

  /**
   * Force flush all buffered logs
   */
  async flushAll(): Promise<void> {
    const sessionIds = Array.from(this.logBuffers.keys());
    await Promise.all(sessionIds.map(sessionId => this.flush(sessionId)));
  }

  /**
   * Clear logs for a session
   */
  async clearSession(sessionId: string): Promise<void> {
    const logPath = getSessionLogPath(sessionId);
    try {
      if (existsSync(logPath)) {
        await fs.unlink(logPath);
      }
      this.logBuffers.delete(sessionId);
      if (this.flushTimers.has(sessionId)) {
        clearTimeout(this.flushTimers.get(sessionId)!);
        this.flushTimers.delete(sessionId);
      }
    } catch (error) {
      console.error(`Failed to clear logs for session ${sessionId}:`, error);
    }
  }
}

export const createLogger = (): ILogger => {
  return new FileLogger();
};
