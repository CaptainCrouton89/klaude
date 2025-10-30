/**
 * MCP server loading from multiple sources
 * Loads MCPs from three scopes with precedence: Local > Project > User
 * 1. User scope: ~/.klaude/.mcp.json (klaude global MCP registry)
 * 2. Project scope: <project>/.mcp.json (shared, version-controlled)
 * 3. Local scope: <project>/.claude/settings.json (project-specific user settings)
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
 * Load local MCPs from .claude/settings.json (project-specific user settings)
 * Returns empty object if file doesn't exist or is invalid
 */
export async function loadLocalMcps(projectRoot: string): Promise<Record<string, McpServerConfig>> {
  const localSettingsPath = path.join(projectRoot, '.claude', 'settings.json');

  if (!existsSync(localSettingsPath)) {
    return {};
  }

  try {
    const content = await fsp.readFile(localSettingsPath, 'utf-8');
    const parsed = JSON.parse(content) as McpJsonFile;

    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      return {};
    }

    return parsed.mcpServers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`Invalid JSON in .claude/settings.json at ${localSettingsPath}`);
    } else if (error instanceof Error) {
      console.warn(`Failed to load .claude/settings.json from ${localSettingsPath}: ${error.message}`);
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
 * Precedence (highest to lowest): Local > Project > User
 * - User: ~/.klaude/.mcp.json
 * - Project: <project>/.mcp.json
 * - Local: <project>/.claude/settings.json
 */
export async function loadAvailableMcps(projectRoot: string): Promise<Record<string, McpServerConfig>> {
  const [userMcps, projectMcps, localMcps] = await Promise.all([
    loadKlaudeMcps(),
    loadProjectMcps(projectRoot),
    loadLocalMcps(projectRoot),
  ]);

  // Merge with correct precedence: local overrides project, project overrides user
  return {
    ...userMcps,    // User scope (lowest priority)
    ...projectMcps, // Project scope (medium priority, overrides user)
    ...localMcps,   // Local scope (highest priority, overrides both)
  };
}
