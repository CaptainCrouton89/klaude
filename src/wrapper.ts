/**
 * Wrapper loop for launching Claude Code and handling session switching
 */

import { spawn } from 'child_process';
import { promises as fs, constants as fsConstants } from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { getKlaudeHome } from '@/utils/path-helper.js';
import { loadConfig } from '@/services/config-loader.js';
import { KlaudeConfig } from '@/types/index.js';
import { initializeDatabase } from '@/db/database.js';
import { createSessionManager } from '@/db/session-manager.js';

const WRAPPER_LOG_PATH = path.join(os.tmpdir(), 'klaude-wrapper.log');

/**
 * Run the Klaude wrapper loop.
 * Launches Claude Code in the foreground, then respawns on session switch markers.
 */
export async function runWrapper(initialArgs: string[] = []): Promise<number> {
  const klaudeHome = getKlaudeHome();
  const nextSessionFile = path.join(klaudeHome, '.next-session');
  const wrapperPidFile = path.join(klaudeHome, '.wrapper-pid');
  const claudePidFile = path.join(klaudeHome, '.claude-pid');
  let currentArgs = [...initialArgs];
  let currentResumeSessionId: string | null = null;

  await fs.mkdir(klaudeHome, { recursive: true });
  await writeWrapperPid(wrapperPidFile);
  await removeFileIfExists(claudePidFile);
  await removeFileIfExists(nextSessionFile);

  const debugEnabled = Boolean(process.env.KLAUDE_DEBUG);
  const config = await loadConfig();
  const claudeBinary = resolveClaudeBinary(config);

  await logDebug(debugEnabled, `Using Claude binary: ${claudeBinary}`);

  try {
    while (true) {
      // If no args provided and no session tracked yet, try to resume most recent
      if (currentArgs.length === 0 && currentResumeSessionId === null) {
        const recentSession = await getMostRecentSession(debugEnabled);
        if (recentSession) {
          await logDebug(debugEnabled, `Resuming most recent Claude session: ${recentSession.resumeId} (klaude ${recentSession.klaudeId})`);
          console.error(chalk.blue('↻'), `Resuming session ${recentSession.resumeId}`);
          currentResumeSessionId = recentSession.resumeId;
          currentArgs = ['--resume', recentSession.resumeId];
          await activateResumeSession(recentSession.resumeId, debugEnabled);
        }
        // If no recent session found, leave args empty - Claude will handle it
      }

      await logDebug(debugEnabled, `Current resume session: ${currentResumeSessionId || 'none'}`);
      await logDebug(debugEnabled, `Launching ${claudeBinary} ${currentArgs.join(' ')}`);

      const child = spawn(claudeBinary, currentArgs, {
        stdio: 'inherit',
        env: process.env,
      });
      await writeClaudePid(claudePidFile, child.pid);

      const forwardedSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      const signalHandler = (signal: NodeJS.Signals) => {
        if (!child.killed) {
          child.kill(signal);
        }
      };

      forwardedSignals.forEach(signal => process.on(signal, signalHandler));

      let lastExitCode = 0;
      try {
        lastExitCode = await waitForChildExit(child);
      } finally {
        forwardedSignals.forEach(signal => process.off(signal, signalHandler));
        await removeFileIfExists(claudePidFile);
      }

      await logDebug(debugEnabled, `Claude exited with code ${lastExitCode}`);

      const nextSessionId = await readNextSession(nextSessionFile);
      if (nextSessionId) {
        console.error(chalk.blue('↻'), `Session switch detected, resuming ${nextSessionId}`);
        await logDebug(debugEnabled, `Switching from ${currentResumeSessionId || 'none'} to ${nextSessionId}`);
        currentResumeSessionId = nextSessionId;
        currentArgs = ['--resume', nextSessionId];
        await activateResumeSession(nextSessionId, debugEnabled);
        continue;
      }

      return lastExitCode;
    }
  } finally {
    await removeFileIfExists(wrapperPidFile);
  }
}

/**
 * Get the most recently active session from the database
 */
async function getMostRecentSession(debugEnabled: boolean): Promise<{ resumeId: string; klaudeId: string } | null> {
  try {
    await initializeDatabase();
    const sessionManager = createSessionManager();
    const sessions = await sessionManager.listSessions();

    if (sessions.length === 0) {
      return null;
    }

    // Prefer sessions that have a Claude session ID recorded
    const withClaudeId = sessions
      .filter(session => typeof session.claudeSessionId === 'string' && session.claudeSessionId.trim().length > 0)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    if (withClaudeId.length > 0) {
      const top = withClaudeId[0];
      return { resumeId: top.claudeSessionId!, klaudeId: top.id };
    }

    // Fall back to the most recently updated session even if Claude ID is missing
    const sorted = sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const fallback = sorted[0];
    await logDebug(debugEnabled, `No Claude session IDs found; falling back to klaude session ${fallback.id}`);
    return { resumeId: fallback.id, klaudeId: fallback.id };
  } catch (error) {
    await logDebug(
      debugEnabled,
      `Failed to get recent session: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once('error', error => reject(error));
    child.once('exit', (code: number | null) => resolve(code ?? 0));
  });
}

async function readNextSession(markerPath: string): Promise<string | null> {
  if (!(await fileExists(markerPath))) {
    return null;
  }

  try {
    const contents = await fs.readFile(markerPath, 'utf-8');
    const sessionId = contents.trim();
    await removeFileIfExists(markerPath);
    return sessionId.length > 0 ? sessionId : null;
  } catch (error) {
    return null;
  }
}

async function writeWrapperPid(pidFile: string): Promise<void> {
  await fs.writeFile(pidFile, `${process.pid}`, 'utf-8');
}

async function writeClaudePid(pidFile: string, pid: number | null | undefined): Promise<void> {
  if (typeof pid !== 'number' || Number.isNaN(pid) || pid <= 0) {
    await removeFileIfExists(pidFile);
    return;
  }
  await fs.writeFile(pidFile, `${pid}`, 'utf-8');
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function logDebug(enabled: boolean, message: string): Promise<void> {
  if (!enabled) {
    return;
  }

  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await fs.appendFile(WRAPPER_LOG_PATH, line, 'utf-8');
  } catch {
    // Ignore logging failures to avoid breaking wrapper execution
  }
}

function resolveClaudeBinary(config: KlaudeConfig): string {
  const candidates = [
    process.env.CLAUDE_BINARY,
    process.env.KLAUDE_CLAUDE_BINARY,
    config?.wrapper?.claudeBinary,
    'claude',
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return 'claude';
}

async function activateResumeSession(resumeId: string, debugEnabled: boolean): Promise<void> {
  try {
    await initializeDatabase();
    const sessionManager = createSessionManager();
    const klaudeSession =
      (await sessionManager.getSessionByClaudeId(resumeId)) ?? (await sessionManager.getSession(resumeId));

    if (klaudeSession) {
      await sessionManager.activateSession(klaudeSession.id);
      await logDebug(debugEnabled, `Activated Klaude session ${klaudeSession.id} for resume ${resumeId}`);
    } else {
      await logDebug(debugEnabled, `No Klaude session found for resume ${resumeId}`);
    }
  } catch (error) {
    await logDebug(
      debugEnabled,
      `Failed to activate session for ${resumeId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
