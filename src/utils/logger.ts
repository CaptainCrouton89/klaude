import { promises as fsp } from 'node:fs';

export interface SessionLogEntry {
  timestamp: string;
  kind: string;
  payload: unknown;
}

/**
 * Append an event to a session log file as a JSON line.
 * Creates parent directories if needed.
 */
export async function appendSessionEvent(
  logPath: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  const entry: SessionLogEntry = {
    timestamp: new Date().toISOString(),
    kind,
    payload,
  };

  const line = `${JSON.stringify(entry)}\n`;
  await fsp.appendFile(logPath, line, 'utf-8');
}
