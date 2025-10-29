/**
 * MCP server loading from multiple sources
 * Loads MCPs from:
 * 1. Project .mcp.json (standard Claude Code format)
 * 2. ~/.klaude/.mcp.json (klaude global MCP registry)
 */

import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { McpServerConfig } from '@/types/index.js';
import { getKlaudeHome } from '@/utils/path-helper.js';

/**
 * Parsed .mcp.json file structure (matches Claude Code format)
 */
interface McpJsonFile {
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Load project .mcp.json file if it exists
 * Returns empty object if file doesn't exist or is invalid
 */
export async function loadProjectMcps(projectRoot: string): Promise<Record<string, McpServerConfig>> {
  const mcpJsonPath = path.join(projectRoot, '.mcp.json');

  if (!existsSync(mcpJsonPath)) {
    return {};
  }

  try {
    const content = await fsp.readFile(mcpJsonPath, 'utf-8');
    const parsed = JSON.parse(content) as McpJsonFile;

    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      console.warn(`Invalid .mcp.json at ${mcpJsonPath}: missing or invalid mcpServers`);
      return {};
    }

    return parsed.mcpServers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`Invalid JSON in .mcp.json at ${mcpJsonPath}`);
    } else if (error instanceof Error) {
      console.warn(`Failed to load .mcp.json from ${mcpJsonPath}: ${error.message}`);
    }
    return {};
  }
}

/**
 * Load MCPs from ~/.klaude/.mcp.json (klaude global MCP registry)
 * Returns empty object if not configured
 */
export async function loadKlaudeMcps(): Promise<Record<string, McpServerConfig>> {
  const klaudeHome = getKlaudeHome();
  const mcpJsonPath = path.join(klaudeHome, '.mcp.json');

  if (!existsSync(mcpJsonPath)) {
    return {};
  }

  try {
    const content = await fsp.readFile(mcpJsonPath, 'utf-8');
    const parsed = JSON.parse(content) as McpJsonFile;

    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      console.warn(`Invalid .mcp.json at ${mcpJsonPath}: missing or invalid mcpServers`);
      return {};
    }

    return parsed.mcpServers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`Invalid JSON in .mcp.json at ${mcpJsonPath}`);
    } else if (error instanceof Error) {
      console.warn(`Failed to load .mcp.json from ${mcpJsonPath}: ${error.message}`);
    }
    return {};
  }
}

/**
 * Load all available MCP servers from all sources
 * Precedence: Project .mcp.json > ~/.klaude/.mcp.json
 */
export async function loadAvailableMcps(projectRoot: string): Promise<Record<string, McpServerConfig>> {
  const [klaudeMcps, projectMcps] = await Promise.all([
    loadKlaudeMcps(),
    loadProjectMcps(projectRoot),
  ]);

  // Project MCPs override klaude global MCPs for same names
  return {
    ...klaudeMcps,
    ...projectMcps,
  };
}
