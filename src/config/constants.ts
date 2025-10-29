/**
 * Application-wide constants and magic values
 */

export const KLAUDE_HOME = '~/.klaude';
export const KLAUDE_DB_PATH = `${KLAUDE_HOME}/sessions.db`;
export const KLAUDE_RUN_DIR = `${KLAUDE_HOME}/run`;
export const KLAUDE_PROJECTS_DIR = `${KLAUDE_HOME}/projects`;
export const KLAUDE_CONFIG_FILE = `${KLAUDE_HOME}/config.yaml`;

// Timeouts (milliseconds)
export const DEFAULT_AGENT_TIMEOUT = 600000; // 10 minutes
export const MESSAGE_WAIT_TIMEOUT = 30000; // 30 seconds
export const DB_BUSY_TIMEOUT = 5000; // 5 seconds

// Session management
export const MAX_CONCURRENT_AGENTS = 10;
export const SESSION_ID_LENGTH = 12;
export const LOG_RETENTION_DAYS = 30;

// Log format
export const LOG_TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ';

// Message queue
export const MESSAGE_POLL_INTERVAL = 1000; // 1 second
export const MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// CLI display
export const TERMINAL_WIDTH = 120;
export const TABLE_STYLE = 'grid';
