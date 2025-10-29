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
    switch?: {
      graceSeconds?: number;
    };
  };
  /**
   * MCP server registry (same format as .mcp.json mcpServers section)
   * Provides named MCP servers that agents can reference
   */
  mcpServers?: Record<string, McpServerConfig>;
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
