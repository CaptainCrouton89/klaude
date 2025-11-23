/**
 * Default configuration values for Klaude
 */

import { KlaudeConfig } from '@/types/index.js';

export const DEFAULT_CONFIG: KlaudeConfig = {
  sdk: {
    model: "claude-haiku-4-5-20251001",
    permissionMode: "bypassPermissions",
    reasoningEffort: "medium",
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
    maxAgentDepth: 2,
    switch: {
      graceSeconds: 1,
    },
    gpt: {
      preferredRuntime: "auto",
      fallbackOnError: true,
      codex: {
        binaryPath: "codex",
        startupRetries: 3,
        startupRetryDelayMs: 400,
        startupRetryJitterMs: 200,
      },
      cursor: {
        binaryPath: "cursor-agent",
        startupRetries: 3,
        startupRetryDelayMs: 400,
        startupRetryJitterMs: 200,
      },
      gemini: {
        binaryPath: "gemini",
        startupRetries: 3,
        startupRetryDelayMs: 400,
        startupRetryJitterMs: 200,
      },
    },
    // Keep old cursor config for backward compatibility
    cursor: {
      startupRetries: 3,
      startupRetryDelayMs: 400,
      startupRetryJitterMs: 200,
    },
  },
};
