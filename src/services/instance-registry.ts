/**
 * Instance registry management with advisory locking for per-project state
 */

import type { ProjectContext } from '@/services/project-context.js';
import { promises as fsp } from 'fs';
import path from 'path';

const REGISTRY_VERSION = 1;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

export interface InstanceRegistryEntry {
  instanceId: string;
  pid: number;
  tty: string | null;
  projectHash: string;
  projectRoot: string;
  socketPath: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

interface InstanceRegistryFile {
  version: number;
  projectHash: string;
  instances: InstanceRegistryEntry[];
}

interface RegisterInstanceOptions {
  instanceId: string;
  pid: number;
  tty: string | null;
  socketPath: string;
}

const defaultRegistry = (projectHash: string): InstanceRegistryFile => ({
  version: REGISTRY_VERSION,
  projectHash,
  instances: [],
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'ESRCH') {
        return false;
      }
      if (errno === 'EPERM') {
        return true;
      }
    }
    throw error;
  }
}

function applyStaleCleanup(entries: InstanceRegistryEntry[]): InstanceRegistryEntry[] {
  const now = new Date().toISOString();
  return entries.map((entry) => {
    if (!entry.endedAt && !isPidAlive(entry.pid)) {
      return {
        ...entry,
        endedAt: now,
        updatedAt: now,
        exitCode: entry.exitCode ?? null,
      };
    }
    return entry;
  });
}

async function readRegistry(context: ProjectContext): Promise<InstanceRegistryFile> {
  try {
    const raw = await fsp.readFile(context.instancesRegistryPath, 'utf-8');
    const parsed = JSON.parse(raw) as InstanceRegistryFile;

    if (
      !parsed.instances ||
      parsed.version !== REGISTRY_VERSION ||
      parsed.projectHash !== context.projectHash
    ) {
      return defaultRegistry(context.projectHash);
    }

    return parsed;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return defaultRegistry(context.projectHash);
      }
    }
    // If parsing fails or unexpected error, reset registry
    return defaultRegistry(context.projectHash);
  }
}

async function writeRegistry(context: ProjectContext, registry: InstanceRegistryFile): Promise<void> {
  await fsp.writeFile(context.instancesRegistryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

async function withRegistryLock<T>(
  context: ProjectContext,
  fn: () => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = path.join(context.runDir, 'instances.lock');
  const start = Date.now();

  while (true) {
    try {
      const handle = await fsp.open(lockPath, 'wx');
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fsp.unlink(lockPath).catch((unlinkError) => {
          if (
            unlinkError &&
            typeof unlinkError === 'object' &&
            'code' in unlinkError &&
            (unlinkError as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            throw unlinkError;
          }
        });
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === 'EEXIST') {
          if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for registry lock at ${lockPath}`);
          }
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
          continue;
        }
      }
      throw error;
    }
  }
}

export async function registerInstance(
  context: ProjectContext,
  options: RegisterInstanceOptions,
): Promise<InstanceRegistryEntry> {
  return await withRegistryLock(context, async () => {
    const registry = await readRegistry(context);
    const cleanedInstances = applyStaleCleanup(registry.instances);

    const now = new Date().toISOString();
    const entry: InstanceRegistryEntry = {
      instanceId: options.instanceId,
      pid: options.pid,
      tty: options.tty,
      projectHash: context.projectHash,
      projectRoot: context.projectRoot,
      socketPath: options.socketPath,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      exitCode: null,
    };

    const existingIndex = cleanedInstances.findIndex(
      (instance) => instance.instanceId === options.instanceId,
    );

    if (existingIndex >= 0) {
      cleanedInstances[existingIndex] = entry;
    } else {
      cleanedInstances.push(entry);
    }

    const updatedRegistry: InstanceRegistryFile = {
      ...registry,
      instances: cleanedInstances,
      version: REGISTRY_VERSION,
    };

    await writeRegistry(context, updatedRegistry);
    return entry;
  });
}

export async function markInstanceEnded(
  context: ProjectContext,
  instanceId: string,
  exitCode: number | null,
): Promise<void> {
  await withRegistryLock(context, async () => {
    const registry = await readRegistry(context);
    const now = new Date().toISOString();

    const updated = registry.instances.map((entry) => {
      if (entry.instanceId !== instanceId) {
        return entry;
      }

      return {
        ...entry,
        endedAt: entry.endedAt ?? now,
        updatedAt: now,
        exitCode,
      };
    });

    await writeRegistry(context, {
      ...registry,
      instances: updated,
    });
  });
}

export async function removeInstance(context: ProjectContext, instanceId: string): Promise<void> {
  await withRegistryLock(context, async () => {
    const registry = await readRegistry(context);
    const filtered = registry.instances.filter((entry) => entry.instanceId !== instanceId);
    await writeRegistry(context, {
      ...registry,
      instances: filtered,
    });
  });
}

export async function listInstances(context: ProjectContext): Promise<InstanceRegistryEntry[]> {
  return await withRegistryLock(context, async () => {
    const registry = await readRegistry(context);
    const cleaned = applyStaleCleanup(registry.instances);
    if (cleaned !== registry.instances) {
      await writeRegistry(context, {
        ...registry,
        instances: cleaned,
      });
    }
    return cleaned;
  });
}
