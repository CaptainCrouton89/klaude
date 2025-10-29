import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type AgentDefinitionScope = 'project' | 'user';

export interface AgentDefinition {
  type: string;
  name: string | null;
  description: string | null;
  instructions: string | null;
  allowedAgents: string[];
  model: string | null;
  color: string | null;
  sourcePath: string | null;
  scope: AgentDefinitionScope;
}

export interface AgentDefinitionLoadOptions {
  projectRoot?: string;
}

const agentCache = new Map<string, AgentDefinition | null>();

interface AgentDirectoryEntry {
  path: string;
  scope: AgentDefinitionScope;
}

function getAgentDirectories(projectRoot?: string): AgentDirectoryEntry[] {
  const directories: AgentDirectoryEntry[] = [];

  if (projectRoot && projectRoot.trim().length > 0) {
    directories.push({
      path: path.resolve(projectRoot, '.claude', 'agents'),
      scope: 'project',
    });
  }

  directories.push({
    path: path.join(homedir(), '.claude', 'agents'),
    scope: 'user',
  });

  const seen = new Set<string>();
  return directories.filter((entry) => {
    const normalized = path.resolve(entry.path);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    entry.path = normalized;
    return true;
  });
}

function normalizeAgentType(agentType: string): string {
  return agentType.trim().toLowerCase();
}

function parseMetadataLine(line: string): { key: string; value: string } | null {
  const separatorIndex = line.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }
  const key = line.slice(0, separatorIndex).trim().toLowerCase();
  const value = line.slice(separatorIndex + 1).trim();
  if (!key) {
    return null;
  }
  return { key, value };
}

function parseAllowedAgents(value: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[\s,]+/)
    .map((part) => normalizeAgentType(part))
    .filter((part) => part.length > 0);
}

function sanitizeText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function parseAgentFile(
  agentPath: string,
  scope: AgentDefinitionScope,
  normalizedType: string,
): Promise<AgentDefinition> {
  const content = await fsp.readFile(agentPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const metadata: Record<string, string> = {};
  let bodyStartIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      bodyStartIndex = index + 1;
      break;
    }
    const parsed = parseMetadataLine(line);
    if (!parsed) {
      bodyStartIndex = index;
      break;
    }
    metadata[parsed.key] = parsed.value;
    bodyStartIndex = index + 1;
  }

  const instructions = sanitizeText(lines.slice(bodyStartIndex).join('\n'));
  const allowedAgents = metadata.allowedagents
    ? parseAllowedAgents(metadata.allowedagents)
    : [];

  return {
    type: normalizedType,
    name: sanitizeText(metadata.name),
    description: sanitizeText(metadata.description),
    instructions,
    allowedAgents,
    model: sanitizeText(metadata.model),
    color: sanitizeText(metadata.color),
    sourcePath: agentPath,
    scope,
  };
}

export function composeAgentPrompt(definition: AgentDefinition | null, userPrompt: string): string {
  const segments: string[] = [];
  if (definition?.description) {
    segments.push(definition.description);
  }
  if (definition?.instructions) {
    segments.push(definition.instructions);
  }
  segments.push(userPrompt);
  return segments.join('\n\n');
}

async function readAgentFile(
  agentType: string,
  directories: AgentDirectoryEntry[],
): Promise<AgentDefinition | null> {
  const normalized = normalizeAgentType(agentType);
  const candidateNames = [
    `${agentType}.md`,
    `${normalized}.md`,
  ];

  const attemptedPaths = new Set<string>();

  for (const directory of directories) {
    for (const fileName of candidateNames) {
      const agentPath = path.resolve(directory.path, fileName);
      if (attemptedPaths.has(agentPath)) {
        continue;
      }
      attemptedPaths.add(agentPath);

      try {
        return await parseAgentFile(agentPath, directory.scope, normalized);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
        }
        throw error;
      }
    }

    let directoryEntries: string[] = [];
    try {
      directoryEntries = await fsp.readdir(directory.path);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
      }
      throw error;
    }

    for (const entryName of directoryEntries) {
      if (!entryName.toLowerCase().endsWith('.md')) {
        continue;
      }

      const baseName = entryName.slice(0, -3);
      if (normalizeAgentType(baseName) !== normalized) {
        continue;
      }

      const agentPath = path.resolve(directory.path, entryName);
      if (attemptedPaths.has(agentPath)) {
        continue;
      }
      attemptedPaths.add(agentPath);

      try {
        return await parseAgentFile(agentPath, directory.scope, normalized);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
        }
        throw error;
      }
    }
  }

  return null;
}

function buildCacheKey(agentType: string, directories: AgentDirectoryEntry[]): string {
  const normalized = normalizeAgentType(agentType);
  const directoryKey = directories.map((entry) => entry.path).join('|');
  return `${normalized}::${directoryKey}`;
}

export async function loadAgentDefinition(
  agentType: string,
  options: AgentDefinitionLoadOptions = {},
): Promise<AgentDefinition | null> {
  const directories = getAgentDirectories(options.projectRoot);
  const cacheKey = buildCacheKey(agentType, directories);

  if (agentCache.has(cacheKey)) {
    return agentCache.get(cacheKey) ?? null;
  }

  const definition = await readAgentFile(agentType, directories);
  agentCache.set(cacheKey, definition);
  return definition;
}
