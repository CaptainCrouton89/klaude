/**
 * MCP server resolution for specific agents
 * Resolves which MCPs an agent should have based on:
 * - Agent frontmatter configuration (mcpServers, inheritProjectMcps, inheritParentMcps)
 * - Available MCP registry
 * - Parent agent's resolved MCPs
 */

import { McpServerConfig } from '@/types/index.js';
import type { AgentDefinition } from './agent-definitions.js';

/**
 * Context for resolving MCPs for a specific agent
 */
export interface McpResolutionContext {
  /**
   * All available MCPs from registries (.mcp.json, config.yaml)
   */
  availableMcps: Record<string, McpServerConfig>;
  /**
   * Agent definition with MCP configuration
   */
  agentDefinition: AgentDefinition;
  /**
   * Parent agent's resolved MCPs (if this is a child agent)
   */
  parentMcps?: Record<string, McpServerConfig>;
}

/**
 * Resolve which MCP servers this agent should have access to
 *
 * Resolution logic:
 * 1. If inheritProjectMcps !== false: Start with all available project MCPs
 * 2. If inheritParentMcps === true: Add parent's MCPs
 * 3. If mcpServers specified: Use ONLY those MCPs (replaces inherited)
 *
 * @throws Error if a specified MCP name is not found in available MCPs
 */
export function resolveMcpServers(context: McpResolutionContext): Record<string, McpServerConfig> {
  const { availableMcps, agentDefinition, parentMcps } = context;
  const resolved: Record<string, McpServerConfig> = {};

  // If agent explicitly specifies mcpServers, use ONLY those (explicit override)
  if (agentDefinition.mcpServers && agentDefinition.mcpServers.length > 0) {
    for (const name of agentDefinition.mcpServers) {
      if (availableMcps[name]) {
        resolved[name] = availableMcps[name];
      } else {
        throw new Error(
          `MCP server "${name}" not found in registry. ` +
            `Available MCPs: ${Object.keys(availableMcps).join(', ') || '(none)'}`
        );
      }
    }
    return resolved;
  }

  // Otherwise, build from inheritance
  // Step 1: Project defaults (unless explicitly disabled)
  if (agentDefinition.inheritProjectMcps !== false) {
    Object.assign(resolved, availableMcps);
  }

  // Step 2: Parent MCPs (if explicitly enabled)
  if (agentDefinition.inheritParentMcps === true && parentMcps) {
    Object.assign(resolved, parentMcps);
  }

  return resolved;
}

/**
 * Validate MCP configuration for an agent
 * Returns array of warning messages (empty if all valid)
 */
export function validateMcpConfiguration(
  agentDefinition: AgentDefinition,
  availableMcps: Record<string, McpServerConfig>
): string[] {
  const warnings: string[] = [];

  if (!agentDefinition.mcpServers || agentDefinition.mcpServers.length === 0) {
    return warnings;
  }

  for (const name of agentDefinition.mcpServers) {
    if (!availableMcps[name]) {
      warnings.push(
        `Agent "${agentDefinition.name || agentDefinition.type}" references unknown MCP "${name}"`
      );
    }
  }

  return warnings;
}
