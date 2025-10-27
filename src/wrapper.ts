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

const WRAPPER_LOG_PATH = path.join(os.tmpdir(), 'klaude-wrapper.log');

/**
 * Run the Klaude wrapper loop.
 * Launches Claude Code in the foreground, then respawns on session switch markers.
 */
export async function runWrapper(initialArgs: string[] = []): Promise<number> {
  const klaudeHome = getKlaudeHome();
  const nextSessionFile = path.join(klaudeHome, '.next-session');
  const wrapperPidFile = path.join(klaudeHome, '.wrapper-pid');
  let currentArgs = [...initialArgs];

  await fs.mkdir(klaudeHome, { recursive: true });
  await writeWrapperPid(wrapperPidFile);
  await removeFileIfExists(nextSessionFile);

  const debugEnabled = Boolean(process.env.KLAUDE_DEBUG);
  const config = await loadConfig();
  const claudeBinary = resolveClaudeBinary(config);

  await logDebug(debugEnabled, `Using Claude binary: ${claudeBinary}`);

  try {
    while (true) {
      await logDebug(debugEnabled, `Launching ${claudeBinary} ${currentArgs.join(' ')}`);

      const child = spawn(claudeBinary, currentArgs, {
        stdio: 'inherit',
        env: process.env,
      });

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
      }

      await logDebug(debugEnabled, `Claude exited with code ${lastExitCode}`);

      const nextSessionId = await readNextSession(nextSessionFile);
      if (nextSessionId) {
        console.error(chalk.blue('↻'), `Session switch detected, resuming ${nextSessionId}`);
        await logDebug(debugEnabled, `Resuming session ${nextSessionId}`);
        currentArgs = ['--resume', nextSessionId];
        continue;
      }

      return lastExitCode;
    }
  } finally {
    await removeFileIfExists(wrapperPidFile);
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
