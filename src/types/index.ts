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
