# CLAUDE.md — docs/libraries

## Purpose

This directory contains reference documentation for external libraries and APIs used by Klaude:
- **typescript-sdk.md** — `@anthropic-ai/claude-agent-sdk` reference
- **hooks-reference.md** — Claude Code hooks configuration and usage
- **cli-reference.md** — Claude Code CLI command reference
- **other-references.md** — Additional external tool documentation

## Maintenance Guidelines

**When to update:**
- External API or SDK versions change significantly
- New Claude Code features are released
- Hooks configuration syntax changes
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
- Keep inline with actual usage patterns in the codebase

**No local implementations here** — This is reference documentation only. Code implementations belong in `src/`, documentation belongs in root CLAUDE.md or component-level docs.
