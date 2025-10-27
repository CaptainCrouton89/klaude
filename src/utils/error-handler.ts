/**
 * Error handling and formatting utilities
 */

import { stderr } from 'process';

export class KlaudeError extends Error {
  constructor(
    message: string,
    public code: string = 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = 'KlaudeError';
  }
}

export class SessionNotFoundError extends KlaudeError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND');
  }
}

export class AgentNotFoundError extends KlaudeError {
  constructor(sessionId: string) {
    super(`Agent not found: ${sessionId}`, 'AGENT_NOT_FOUND');
  }
}

export class DatabaseError extends KlaudeError {
  constructor(message: string) {
    super(`Database error: ${message}`, 'DATABASE_ERROR');
  }
}

export class ConfigError extends KlaudeError {
  constructor(message: string) {
    super(`Configuration error: ${message}`, 'CONFIG_ERROR');
  }
}

export class ValidationError extends KlaudeError {
  constructor(message: string) {
    super(`Validation error: ${message}`, 'VALIDATION_ERROR');
  }
}

/**
 * Format error for terminal output
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error instanceof KlaudeError) {
      return `[${error.code}] ${error.message}`;
    }
    return `[ERROR] ${error.message}`;
  }
  return `[ERROR] ${String(error)}`;
}

/**
 * Print error to stderr
 */
export function printError(error: unknown): void {
  const formatted = formatError(error);
  stderr.write(`\n❌ ${formatted}\n\n`);
}

/**
 * Validate required argument presence
 */
export function requireArg(value: unknown, argName: string): string {
  if (!value || typeof value !== 'string') {
    throw new ValidationError(`Missing required argument: ${argName}`);
  }
  return value;
}

/**
 * Safe async execution with explicit error handling
 *
 * All caught errors are logged, optionally transformed to KlaudeError, and re-thrown.
 * Exhaustively handles: KlaudeError, Error, and unknown types.
 */
export async function safeExecute<T>(
  fn: () => Promise<T>,
  context: string,
): Promise<T> {
  return await executeAndHandleErrors(fn, context);
}

/**
 * Internal helper with explicit error handling (return type: Promise<T>)
 * All caught errors result in a throw statement.
 */
async function executeAndHandleErrors<T>(
  fn: () => Promise<T>,
  context: string,
): Promise<T> {
  let result: T | undefined;
  let caughtErrorValue: unknown | undefined;

  try {
    result = await fn();
  } catch (error: unknown) {
    caughtErrorValue = error;
  }

  // Handle caught error if one occurred
  if (caughtErrorValue !== undefined) {
    const error = caughtErrorValue;

    if (error instanceof KlaudeError) {
      stderr.write(`[${error.code}] ${error.message}\n`);
      throw error;
    }

    if (error instanceof Error) {
      stderr.write(`[EXECUTION_ERROR] Error during ${context}: ${error.message}\n`);
      const wrapped = new KlaudeError(
        `Error during ${context}: ${error.message}`,
        'EXECUTION_ERROR',
      );
      wrapped.stack = error.stack;
      throw wrapped;
    }

    // Unknown/primitive type
    const msg = typeof error === 'string' ? error : JSON.stringify(error);
    stderr.write(`[UNKNOWN_ERROR] Error during ${context}: ${msg}\n`);
    throw new KlaudeError(`Error during ${context}: ${msg}`, 'UNKNOWN_ERROR');
  }

  // No error occurred, return result
  return result as T;
}
