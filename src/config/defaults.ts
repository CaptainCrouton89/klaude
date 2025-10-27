/**
 * Default configuration values for Klaude
 */

import { KlaudeConfig } from '@/types/index.js';

export const DEFAULT_CONFIG: KlaudeConfig = {
  sdk: {
    model: "claude-haiku-4-5-20251001",
    permissionMode: "bypassPermissions",
  },
  server: {
    enabled: false,
    port: 8000,
  },
  wrapper: {
    claudeBinary:
      "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    socketDir: "~/.klaude/run",
    projectsDir: "~/.klaude/projects",
    switch: {
      graceSeconds: 1,
    },
  },
};
