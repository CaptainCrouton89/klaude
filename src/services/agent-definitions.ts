import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

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
  /**
   * MCP server names to enable for this agent (e.g., ['sql', 'json'])
   * References names from available MCP registries (.mcp.json, config.yaml)
   */
  mcpServers?: string[];
  /**
   * Whether to inherit MCPs from project .mcp.json
   * Default: true (inherit project MCPs unless explicitly disabled)
   */
  inheritProjectMcps?: boolean;
  /**
   * Whether to inherit MCPs from parent agent
   * Default: false (independent MCP configuration unless explicitly enabled)
   */
  inheritParentMcps?: boolean;
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

function parseAllowedAgents(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? normalizeAgentType(entry) : ''))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((part) => normalizeAgentType(part))
      .filter((part) => part.length > 0);
  }
  return [];
}

function parseMcpServers(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return [];
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return undefined;
}

function sanitizeText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    const stringValue = String(value).trim();
    return stringValue.length > 0 ? stringValue : null;
  }
  return null;
}

async function parseAgentFile(
  agentPath: string,
  scope: AgentDefinitionScope,
  normalizedType: string,
): Promise<AgentDefinition> {
  const content = await fsp.readFile(agentPath, 'utf8');
  const lines = content.split(/\r?\n/);
  let bodyStartIndex = 0;

  const metadataEntries = new Map<string, unknown>();
  const setMetadata = (key: string, value: unknown): void => {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey.length === 0) {
      return;
    }
    metadataEntries.set(normalizedKey, value);
  };

  let consumedFrontmatter = false;
  const firstLine = lines[0]?.trim();
  if (firstLine === '---') {
    let closingIndex = -1;
    for (let index = 1; index < lines.length; index += 1) {
      const candidate = lines[index];
      if (!candidate) {
        continue;
      }
      const trimmed = candidate.trim();
      if (trimmed === '---' || trimmed === '...') {
        closingIndex = index;
        break;
      }
    }
    if (closingIndex > 0) {
      const frontmatterLines = lines.slice(1, closingIndex);
      const frontmatterText = frontmatterLines.join('\n');
      try {
        const parsed = yaml.load(frontmatterText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Frontmatter must be a YAML mapping');
        }
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          setMetadata(key, value);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse agent frontmatter (${agentPath}): ${message}`);
      }
      consumedFrontmatter = true;
      bodyStartIndex = closingIndex + 1;
      while (bodyStartIndex < lines.length && lines[bodyStartIndex]?.trim().length === 0) {
        bodyStartIndex += 1;
      }
    } else {
      throw new Error(
        `Agent definition ${path.basename(agentPath)} is missing a closing frontmatter delimiter ('---' or '...')`,
      );
    }
  }

  if (!consumedFrontmatter) {
    throw new Error(
      `Agent definition ${path.basename(agentPath)} must start with YAML frontmatter delimited by '---'`,
    );
  }

  const instructions = sanitizeText(lines.slice(bodyStartIndex).join('\n'));
  const allowedAgents = parseAllowedAgents(metadataEntries.get('allowedagents'));
  const mcpServers = parseMcpServers(metadataEntries.get('mcpservers'));
  const inheritProjectMcps = parseBoolean(metadataEntries.get('inheritprojectmcps'));
  const inheritParentMcps = parseBoolean(metadataEntries.get('inheritparentmcps'));

  return {
    type: normalizedType,
    name: sanitizeText(metadataEntries.get('name')),
    description: sanitizeText(metadataEntries.get('description')),
    instructions,
    allowedAgents,
    model: sanitizeText(metadataEntries.get('model')),
    color: sanitizeText(metadataEntries.get('color')),
    sourcePath: agentPath,
    scope,
    mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
    inheritProjectMcps,
    inheritParentMcps,
  };
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
