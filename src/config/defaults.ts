/**
 * Default configuration values for Klaude
 */

import { KlaudeConfig } from '@/types/index.js';

export const DEFAULT_CONFIG: KlaudeConfig = {
  sdk: {
    model: 'claude-haiku-4-5-20251001',
    maxThinkingTokens: 8000,
    permissionMode: 'bypassPermissions',
  },
  session: {
    autoSaveIntervalMs: 5000,
    logRetentionDays: 30,
    maxConcurrentAgents: 10,
  },
  server: {
    enabled: false,
    port: 8000,
  },
};
