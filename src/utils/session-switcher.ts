/**
 * Session switching utilities - coordinate marker files and process handoff.
 */

import { promises as fsPromises } from 'fs';
import path from 'path';
import { getKlaudeHome } from '@/utils/path-helper.js';

const fs = fsPromises;
const DEFAULT_KILL_DELAY_MS = 200;

export interface SessionSwitchOptions {
  /**
   * Explicit process IDs to terminate after writing the marker.
   */
  killPids?: number[];
  /**
   * Delay before signalling parent/Claude process (in milliseconds).
   * Helps ensure the marker file is flushed before kill.
   */
  killDelayMs?: number;
}

export interface SessionSwitchResult {
  /**
   * Absolute path to the marker file that was written.
   */
  markerPath: string;
  /**
   * Whether any kill attempt was made.
   */
  killAttempted: boolean;
  /**
   * PID that was successfully terminated, if any.
   */
  killedPid?: number;
  /**
   * Error message if kill was attempted but failed.
   */
  killError?: string;
}

/**
 * Write the session marker and terminate the active Claude CLI so the wrapper can resume.
 * @param sessionId Claude Code session identifier to resume.
 */
export async function scheduleSessionSwitch(sessionId: string, options: SessionSwitchOptions = {}): Promise<SessionSwitchResult> {
  const klaudeHome = getKlaudeHome();
  const nextSessionPath = path.join(klaudeHome, '.next-session');
  const claudePidPath = path.join(klaudeHome, '.claude-pid');

  await fs.mkdir(klaudeHome, { recursive: true });
  await fs.writeFile(nextSessionPath, `${sessionId}\n`, 'utf-8');

  const delay = options.killDelayMs ?? DEFAULT_KILL_DELAY_MS;
  if (delay > 0) {
    await sleep(delay);
  }

  const candidatePids = await collectCandidatePids(options.killPids, claudePidPath);

  let killAttempted = candidatePids.length > 0;
  let killedPid: number | undefined;
  let killError: string | undefined;

  for (const pid of candidatePids) {
    try {
      process.kill(pid, 'SIGTERM');
      killedPid = pid;
      killError = undefined;
      break;
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr.code === 'ESRCH') {
        // Process already exited, try next candidate
        continue;
      }
      killError = nodeErr.message || 'Failed to terminate process.';
      break;
    }
  }

  return {
    markerPath: nextSessionPath,
    killAttempted,
    killedPid,
    killError,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function collectCandidatePids(explicitPids: number[] | undefined, claudePidPath: string): Promise<number[]> {
  const candidates: number[] = [];
  const seen = new Set<number>();

  const addPid = (pid: number | null | undefined) => {
    if (typeof pid !== 'number' || Number.isNaN(pid) || pid <= 1) {
      return;
    }
    if (!seen.has(pid)) {
      seen.add(pid);
      candidates.push(pid);
    }
  };

  explicitPids?.forEach(addPid);

  const claudePid = await readPidFile(claudePidPath);
  addPid(claudePid);

  return candidates;
}

async function readPidFile(filePath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = parseInt(raw.trim(), 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'EACCES') {
      return null;
    }
    return null;
  }
}
