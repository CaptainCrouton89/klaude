# CLAUDE.md — docs/libraries

## Purpose

This directory contains reference documentation for external libraries, APIs, and protocols used by Klaude:
- **typescript-sdk.md** — `@anthropic-ai/claude-agent-sdk` reference
- **mcp-reference.md** — Model Context Protocol (MCP) servers: setup, configuration, and integration guide
- **plugins.md** — Claude Code plugins system (creating, installing, distributing plugins)
- **hooks-reference.md** — Claude Code hooks configuration and usage
- **cli-reference.md** — Claude Code CLI command reference
- **other-references.md** — Additional external library references

## Maintenance Guidelines

**When to update:**
- External API or SDK versions change significantly
- New Claude Code features are released
- MCP servers, plugins system, hooks configuration, or CLI syntax changes
- Reference documentation becomes outdated or incomplete

**Update approach:**
- Use `library-docs-writer` agent for researching and compressing latest external docs
- Update only the affected reference file, not the entire set
- Include version/date information when documenting external APIs
- Link back to official upstream documentation when possible

**Structure:**
- Each file focuses on a single external system
- Include examples and common usage patterns
- Document constraints, gotchas, and version-specific behavior
