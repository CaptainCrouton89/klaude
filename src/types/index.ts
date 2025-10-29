/**
 * MCP server configuration types (matches Claude Code .mcp.json format and SDK types)
 */
export type McpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Claude CLI flags configuration
 */
export interface ClaudeCliFlags {
  /** One-time flags (only used on initial launch) */
  oneTime: string[];
  /** Persistent flags (used on all launches including checkouts) */
  persistent: string[];
}

/**
 * Configuration structure from ~/.klaude/config.yaml
 */
export interface KlaudeConfig {
  sdk: {
    model: string;
    permissionMode?: string;
    fallbackModel?: string;
  };
  server?: {
    enabled: boolean;
    port: number;
  };
  wrapper?: {
    claudeBinary?: string;
    socketDir?: string;
    projectsDir?: string;
    cliFlags?: ClaudeCliFlags;
    switch?: {
      graceSeconds?: number;
    };
  };
}

/**
 * Parsed CLI arguments
 */
export interface ParsedArgs {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/**
 * Database query result wrapper
 */
export interface QueryResult<T> {
  data: T[];
  count: number;
  error?: string;
}

// Export all database entity types
export * from './db.js';
