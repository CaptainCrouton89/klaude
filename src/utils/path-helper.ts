/**
 * Path utilities for Klaude home directory management
 */

import { homedir } from 'os';
import path from 'path';
import {
  KLAUDE_HOME,
  KLAUDE_DB_PATH,
  KLAUDE_RUN_DIR,
  KLAUDE_PROJECTS_DIR,
  KLAUDE_CONFIG_FILE,
} from '@/config/constants.js';

/**
 * Expand ~ to user home directory
 */
export function expandHome(targetPath: string): string {
  if (targetPath.startsWith('~')) {
    return path.join(homedir(), targetPath.slice(1));
  }
  return targetPath;
}

/**
 * Get Klaude home directory path (expanded)
 */
export function getKlaudeHome(): string {
  return expandHome(KLAUDE_HOME);
}

/**
 * Get database file path (expanded)
 */
export function getDbPath(): string {
  return expandHome(KLAUDE_DB_PATH);
}

/**
 * Get config file path (expanded)
 */
export function getConfigFilePath(): string {
  return expandHome(KLAUDE_CONFIG_FILE);
}

/**
 * Get global run directory root (expanded)
 */
export function getRunRoot(rootOverride?: string): string {
  return expandHome(rootOverride ?? KLAUDE_RUN_DIR);
}

/**
 * Get global projects directory root (expanded)
 */
export function getProjectsRoot(rootOverride?: string): string {
  return expandHome(rootOverride ?? KLAUDE_PROJECTS_DIR);
}

/**
 * Get per-project directory under ~/.klaude/projects/<hash>
 */
export function getProjectDirectory(projectHash: string, rootOverride?: string): string {
  return path.join(getProjectsRoot(rootOverride), projectHash);
}

/**
 * Get per-project logs directory
 */
export function getProjectLogsDirectory(projectHash: string, rootOverride?: string): string {
  return path.join(getProjectDirectory(projectHash, rootOverride), 'logs');
}

/**
 * Get per-project run directory (sockets, registry)
 */
export function getProjectRunDirectory(projectHash: string, rootOverride?: string): string {
  return path.join(getRunRoot(rootOverride), projectHash);
}

/**
 * Get per-instance socket path
 */
export function getInstanceSocketPath(
  projectHash: string,
  instanceId: string,
  runRootOverride?: string,
): string {
  const projectRunDir = getProjectRunDirectory(projectHash, runRootOverride);
  const socketName = instanceId.slice(-8);
  const socketPath = path.join(projectRunDir, socketName);

  const byteLength = Buffer.byteLength(socketPath);
  const unixMaxPath = 103; // leave space for null terminator
  if (byteLength > unixMaxPath) {
    throw new Error(
      `Instance socket path exceeds Unix domain socket limit (${byteLength} bytes). ` +
        'Set wrapper.socketDir to a shorter path in ~/.klaude/config.yaml.',
    );
  }

  return socketPath;
}

/**
 * Get per-project instance registry path
 */
export function getInstanceRegistryPath(projectHash: string, runRootOverride?: string): string {
  return path.join(getProjectRunDirectory(projectHash, runRootOverride), 'instances.json');
}

/**
 * Get per-session log file path
 */
export function getSessionLogPath(
  projectHash: string,
  sessionId: string,
  projectsRootOverride?: string
): string {
  return path.join(
    getProjectLogsDirectory(projectHash, projectsRootOverride),
    `session-${sessionId}.log`
  );
}
