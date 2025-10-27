/**
 * Path utilities for Klaude home directory management
 */

import { homedir } from 'os';
import { join } from 'path';
import { KLAUDE_HOME, KLAUDE_DB_PATH, KLAUDE_LOGS_DIR, KLAUDE_CONFIG_FILE } from '@/config/constants.js';

/**
 * Expand ~ to user home directory
 */
export function expandHome(path: string): string {
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/**
 * Get Klaude home directory path (expanded)
 */
export function getKlaudeHome(): string {
  return expandHome(KLAUDE_HOME);
}

/**
 * Get database file path (expanded)
 */
export function getDbPath(): string {
  return expandHome(KLAUDE_DB_PATH);
}

/**
 * Get logs directory path (expanded)
 */
export function getLogsDir(): string {
  return expandHome(KLAUDE_LOGS_DIR);
}

/**
 * Get config file path (expanded)
 */
export function getConfigFilePath(): string {
  return expandHome(KLAUDE_CONFIG_FILE);
}

/**
 * Get session log file path
 */
export function getSessionLogPath(sessionId: string): string {
  return join(getLogsDir(), `session-${sessionId}.log`);
}
