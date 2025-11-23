import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { WriteStream } from 'node:tty';

/**
 * Logs debug messages when KLAUDE_DEBUG environment variable is set to 'true'
 */
export function debugLog(...args: unknown[]): void {
  if (process.env.KLAUDE_DEBUG === 'true') {
    console.error('[wrapper-instance]', ...args);
  }
}

/**
 * Logs verbose debug messages when KLAUDE_DEBUG_VERBOSE environment variable is set to 'true'
 */
export function verboseLog(...args: unknown[]): void {
  if (process.env.KLAUDE_DEBUG_VERBOSE === 'true') {
    console.error('[wrapper-instance]', ...args);
  }
}

/**
 * Detects the TTY path from stdout or stderr streams
 * @returns The TTY path if available, null otherwise
 */
export function detectTtyPath(): string | null {
  const streams = [process.stdout, process.stderr] as WriteStream[];
  for (const stream of streams) {
    if (stream.isTTY) {
      const ttyStream = stream as WriteStream & { path?: unknown };
      if (typeof ttyStream.path === 'string' && ttyStream.path.length > 0) {
        return ttyStream.path;
      }
    }
  }
  return null;
}

/**
 * Ensures the Unix socket file is removed before starting the server
 * @param socketPath - Path to the Unix socket file
 */
export async function ensureSocketClean(socketPath: string): Promise<void> {
  try {
    await fsp.unlink(socketPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
    }
    throw error;
  }
}

/**
 * Ensures the log file exists, creating it if necessary
 * @param logPath - Path to the log file
 */
export async function ensureLogFile(logPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  try {
    await fsp.access(logPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await fsp.writeFile(logPath, '', 'utf-8');
        return;
      }
    }
    throw error;
  }
}
