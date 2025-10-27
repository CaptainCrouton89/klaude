/**
 * Project context resolution: canonical root, project hash, directory scaffolding
 */

import { loadConfig } from '@/services/config-loader.js';
import {
  getProjectDirectory,
  getProjectLogsDirectory,
  getProjectRunDirectory,
  getProjectsRoot,
  getRunRoot,
  getInstanceRegistryPath,
} from '@/utils/path-helper.js';
import { createHash } from 'crypto';
import { promises as fsp } from 'fs';

export interface ProjectContext {
  projectRoot: string;
  projectHash: string;
  projectsRoot: string;
  runRoot: string;
  projectDir: string;
  logsDir: string;
  runDir: string;
  instancesRegistryPath: string;
}

/**
 * Resolve canonical project root path
 */
async function resolveCanonicalProjectRoot(cwd: string): Promise<string> {
  const stats = await fsp.stat(cwd);
  if (!stats.isDirectory()) {
    throw new Error(`Project root must be a directory: ${cwd}`);
  }
  return await fsp.realpath(cwd);
}

/**
 * Derive SHA-256 hash for project path
 */
function deriveProjectHash(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex');
}

/**
 * Ensure a directory exists, creating parents as needed
 */
async function ensureDirectory(targetPath: string): Promise<void> {
  await fsp.mkdir(targetPath, { recursive: true });
}

/**
 * Prepare project context for the current working directory
 */
export async function prepareProjectContext(cwd: string = process.cwd()): Promise<ProjectContext> {
  const [config, projectRoot] = await Promise.all([loadConfig(), resolveCanonicalProjectRoot(cwd)]);
  const projectHash = deriveProjectHash(projectRoot);

  const wrapperConfig = config.wrapper ?? {};

  const projectsRoot = getProjectsRoot(wrapperConfig.projectsDir);
  const runRoot = getRunRoot(wrapperConfig.socketDir);

  const projectDir = getProjectDirectory(projectHash, wrapperConfig.projectsDir);
  const logsDir = getProjectLogsDirectory(projectHash, wrapperConfig.projectsDir);
  const runDir = getProjectRunDirectory(projectHash, wrapperConfig.socketDir);
  const instancesRegistryPath = getInstanceRegistryPath(projectHash, wrapperConfig.socketDir);

  await Promise.all([ensureDirectory(projectsRoot), ensureDirectory(runRoot)]);
  await Promise.all([ensureDirectory(projectDir), ensureDirectory(logsDir), ensureDirectory(runDir)]);

  return {
    projectRoot,
    projectHash,
    projectsRoot,
    runRoot,
    projectDir,
    logsDir,
    runDir,
    instancesRegistryPath,
  };
}
