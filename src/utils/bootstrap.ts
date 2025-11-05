import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants as fsConstants, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expectedModuleVersion = process.env.KLAUDE_NODE_MODULE_VERSION ?? null;
const preferredNodeBin = process.env.KLAUDE_NODE_BIN ?? null;
const alreadyReexeced = process.env.KLAUDE_NODE_REEXEC === '1';

const envLogPath = process.env.KLAUDE_BOOTSTRAP_LOG;
let bootstrapLogPath =
  envLogPath && envLogPath.length > 0
    ? envLogPath
    : path.join(os.tmpdir(), `klaude-bootstrap-${process.pid}.log`);
process.env.KLAUDE_BOOTSTRAP_LOG = bootstrapLogPath;

export function logBootstrap(message: string): void {
  if (!bootstrapLogPath) {
    return;
  }
  try {
    appendFileSync(
      bootstrapLogPath,
      `[${new Date().toISOString()}] pid=${process.pid} ${message}\n`,
      'utf8',
    );
  } catch {
    // ignore logging failures
  }
}

function parseModuleMismatch(error: unknown): {
  requiredVersion: string;
  currentVersion: string | null;
  requiredArch: string | null;
} | null {
  if (!error) {
    return null;
  }

  const message = error instanceof Error ? error.message : String(error);
  const versionMatches = [...message.matchAll(/NODE_MODULE_VERSION (\d+)/g)];
  if (versionMatches.length === 0) {
    return null;
  }

  const requiredVersion = versionMatches[0]?.[1] ?? null;
  if (!requiredVersion) {
    return null;
  }

  const currentVersion = versionMatches.length > 1 ? versionMatches[1]?.[1] ?? null : null;
  const archMatch = message.match(/incompatible architecture \(have '([^']+)', need '([^']+)'\)/);
  const requiredArch = archMatch ? archMatch[2] ?? null : null;

  return {
    requiredVersion,
    currentVersion,
    requiredArch,
  };
}

function appendIfMissing(list: string[], value: string): void {
  if (!value) {
    return;
  }
  if (!list.includes(value)) {
    list.push(value);
  }
}

function collectHomebrewNodeBinaries(): string[] {
  const results: string[] = [];
  const prefixes = new Set<string>();
  if (process.env.HOMEBREW_PREFIX) {
    prefixes.add(process.env.HOMEBREW_PREFIX);
  }
  prefixes.add('/opt/homebrew');
  prefixes.add('/usr/local');

  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }

    const optDir = path.join(prefix, 'opt');
    try {
      const entries = readdirSync(optDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name !== 'node' && !entry.name.startsWith('node@')) {
          continue;
        }
        const candidate = path.join(optDir, entry.name, 'bin', 'node');
        appendIfMissing(results, candidate);
      }
    } catch {
      // ignore missing opt directory
    }

    const cellarDir = path.join(prefix, 'Cellar');
    try {
      const entries = readdirSync(cellarDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name !== 'node' && !entry.name.startsWith('node@')) {
          continue;
        }
        const versionDir = path.join(cellarDir, entry.name);
        try {
          const versions = readdirSync(versionDir, { withFileTypes: true });
          for (const version of versions) {
            if (!version.isDirectory()) {
              continue;
            }
            const candidate = path.join(versionDir, version.name, 'bin', 'node');
            appendIfMissing(results, candidate);
          }
        } catch {
          // ignore traversal failures
        }
      }
    } catch {
      // ignore missing cellar directory
    }
  }

  return results;
}

function findNodeBinary(targetVersion: string, preferred: string | null): string | null {
  const seen = new Set<string>();
  const candidates: string[] = [];

  if (preferred && preferred.length > 0) {
    logBootstrap(`findNodeBinary target=${targetVersion} preferred=${preferred}`);
    candidates.push(preferred);
  }

  const pathValue = process.env.PATH;
  if (!pathValue) {
    logBootstrap('findNodeBinary PATH is not set');
    return null;
  }
  logBootstrap(`findNodeBinary PATH=${pathValue}`);
  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) {
      continue;
    }
    candidates.push(path.join(segment, 'node'));
  }

  for (const candidate of collectHomebrewNodeBinaries()) {
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    if (!candidate || candidate.length === 0) {
      continue;
    }

    let resolved: string;
    try {
      resolved = path.resolve(candidate);
    } catch {
      continue;
    }

    if (resolved === process.execPath) {
      continue;
    }
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);

    try {
      accessSync(resolved, fsConstants.X_OK);
    } catch {
      logBootstrap(`findNodeBinary candidate=${resolved} not executable`);
      continue;
    }

    try {
      const modulesVersion = execFileSync(resolved, ['-p', 'process.versions.modules'], {
        encoding: 'utf8',
      }).trim();
      if (modulesVersion !== targetVersion) {
        logBootstrap(
          `findNodeBinary candidate=${resolved} modules=${modulesVersion} does not match target=${targetVersion}`,
        );
        continue;
      }

      const arch = execFileSync(resolved, ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
      if (arch !== process.arch) {
        logBootstrap(
          `findNodeBinary candidate=${resolved} arch=${arch} does not match process.arch=${process.arch}`,
        );
        continue;
      }

      logBootstrap(`findNodeBinary selected=${resolved}`);
      return resolved;
    } catch {
      logBootstrap(`findNodeBinary candidate=${resolved} threw during inspection`);
      continue;
    }
  }

  logBootstrap(`findNodeBinary target=${targetVersion} no candidate found`);
  return null;
}

function reexecWithNode(nodePath: string, targetVersion: string, reason: string): never {
  const env = {
    ...process.env,
    KLAUDE_NODE_BIN: nodePath,
    KLAUDE_NODE_MODULE_VERSION: targetVersion,
    KLAUDE_NODE_REEXEC: '1',
    KLAUDE_NODE_REEXEC_REASON: reason,
  };

  logBootstrap(
    `reexecWithNode node=${nodePath} reason=${reason} targetVersion=${targetVersion} argv=${JSON.stringify(process.argv.slice(1))}`,
  );

  const result = spawnSync(nodePath, process.argv.slice(1), {
    env,
    stdio: 'inherit',
  });
  logBootstrap(`reexecWithNode child exited status=${result.status ?? 'null'}`);
  process.exit(result.status ?? 1);
}

export async function ensureCompatibleNode(): Promise<void> {
  logBootstrap(
    `ensureCompatibleNode begin expected=${expectedModuleVersion ?? 'null'} modules=${process.versions.modules} alreadyReexeced=${alreadyReexeced}`,
  );
  if (expectedModuleVersion && process.versions.modules !== expectedModuleVersion) {
    const candidate = findNodeBinary(expectedModuleVersion, preferredNodeBin);
    if (!candidate) {
      console.error(
        `❌ Native module ABI mismatch: expected ${expectedModuleVersion}, got ${process.versions.modules}.`,
      );
      if (preferredNodeBin) {
        console.error(`   Preferred Node binary: ${preferredNodeBin}`);
      }
      console.error('   Unable to locate a compatible Node binary on PATH.');
      logBootstrap(
        `ensureCompatibleNode mismatch expected=${expectedModuleVersion} modules=${process.versions.modules} candidate=none`,
      );
      process.exit(1);
    }
    logBootstrap(
      `ensureCompatibleNode mismatch expected=${expectedModuleVersion} modules=${process.versions.modules} candidate=${candidate}`,
    );
    reexecWithNode(candidate, expectedModuleVersion, 'env_mismatch');
  }

  let mismatch: ReturnType<typeof parseModuleMismatch> | null = null;
  try {
    const imported = await import('better-sqlite3');
    const databaseCtor = (imported as { default?: unknown }).default ?? imported;

    if (typeof databaseCtor === 'function') {
      let db: { close?: () => unknown } | null = null;
      try {
        const Ctor = databaseCtor as new (...args: unknown[]) => { close?: () => unknown };
        db = new Ctor(':memory:');
      } catch (innerError) {
        mismatch = parseModuleMismatch(innerError);
        if (!mismatch) {
          logBootstrap(
            `ensureCompatibleNode in-memory instantiation failed without detectable mismatch: ${innerError instanceof Error ? innerError.message : String(innerError)}`,
          );
          throw innerError;
        }
      } finally {
        if (db && typeof db.close === 'function') {
          try {
            db.close();
          } catch {
            // ignore close errors
          }
        }
      }
    }
  } catch (error) {
    mismatch = parseModuleMismatch(error);
    if (!mismatch) {
      logBootstrap(
        `ensureCompatibleNode import failed without detectable mismatch: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  if (mismatch && alreadyReexeced) {
    console.error('❌ Native module ABI mismatch persists after re-exec.');
    console.error(`   Required ABI: ${mismatch.requiredVersion}`);
    if (mismatch.currentVersion) {
      console.error(`   Current ABI: ${mismatch.currentVersion}`);
    }
    if (mismatch.requiredArch && mismatch.requiredArch !== process.arch) {
      console.error(`   Required architecture: ${mismatch.requiredArch}`);
      console.error(`   Current architecture: ${process.arch}`);
    }
    console.error('   Consider reinstalling dependencies with a compatible Node version.');
    logBootstrap(
      `ensureCompatibleNode mismatch persists required=${mismatch.requiredVersion} current=${mismatch.currentVersion ?? 'unknown'} archRequired=${mismatch.requiredArch ?? 'unknown'} archCurrent=${process.arch}`,
    );
    process.exit(1);
  }

  if (!mismatch) {
    if (!process.env.KLAUDE_NODE_MODULE_VERSION) {
      process.env.KLAUDE_NODE_MODULE_VERSION = process.versions.modules;
    }
    if (!process.env.KLAUDE_NODE_BIN) {
      process.env.KLAUDE_NODE_BIN = process.execPath;
    }
    logBootstrap(
      `ensureCompatibleNode complete without mismatch modules=${process.versions.modules} exec=${process.execPath}`,
    );
    return;
  }

  const candidate = findNodeBinary(mismatch.requiredVersion, preferredNodeBin);
  if (!candidate) {
    console.error(
      `❌ Native module ABI mismatch: found better-sqlite3 built for ABI ${mismatch.requiredVersion}, but unable to locate a matching Node binary.`,
    );
    console.error(`   Current Node ABI: ${process.versions.modules} (${process.execPath})`);
    console.error('   Install a matching Node version or rebuild better-sqlite3 for your runtime.');
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      console.error(
        '   Apple Silicon tip: run the rebuild from an arm64 shell (e.g. `arch -arm64 zsh`) to avoid generating x86_64 binaries under Rosetta.',
      );
    }
    logBootstrap(
      `ensureCompatibleNode mismatch detected required=${mismatch.requiredVersion} but no candidate found`,
    );
    process.exit(1);
  }

  logBootstrap(
    `ensureCompatibleNode mismatch detected required=${mismatch.requiredVersion} reexec candidate=${candidate}`,
  );
  reexecWithNode(candidate, mismatch.requiredVersion, 'auto_detected');
}
