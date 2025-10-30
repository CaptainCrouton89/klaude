import path from 'node:path';

/**
 * Resolve project directory from command-line option or default to current working directory.
 */
export function resolveProjectDirectory(cwdOption?: string): string {
  return cwdOption ? path.resolve(cwdOption) : process.cwd();
}

/**
 * Parse Claude CLI flags from command line arguments.
 * Classifies flags into one-time (e.g., -r) and persistent (e.g., --dangerously-skip-permissions).
 */
export function parseClaudeFlags(flags: string[]): { oneTime: string[]; persistent: string[] } {
  const oneTimePatterns = ['-r'];
  const persistentPatterns = ['--dangerously-skip-permissions'];

  return {
    oneTime: flags.filter(f => oneTimePatterns.includes(f)),
    persistent: flags.filter(f => persistentPatterns.includes(f)),
  };
}

/**
 * Read all input from stdin as a UTF-8 string.
 * Returns empty string if stdin is a TTY.
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }

  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    process.stdin.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.once('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Abbreviate a session ID by taking the last 6 characters (random portion of ULID).
 * ULIDs are 26 chars: 10 char timestamp + 16 char random. Last 6 chars provide good uniqueness.
 */
export function abbreviateSessionId(sessionId: string): string {
  return sessionId.slice(-6);
}
