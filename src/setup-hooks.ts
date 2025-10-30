#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface Hook {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

interface Settings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  hooks?: Record<string, Hook[]>;
  [key: string]: unknown;
}

const KLAUDE_HOOKS: Record<string, Hook[]> = {
  PreToolUse: [
    {
      matcher: "Task",
      hooks: [{ type: "command", command: "klaude hook task" }],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [{ type: "command", command: "klaude hook pre-user-message" }],
    },
  ],
  SessionStart: [
    {
      hooks: [{ type: "command", command: "klaude hook session-start" }],
    },
    {
      matcher: "startup",
      hooks: [{ type: "command", command: "klaude hook session-start" }],
    },
    {
      matcher: "resume",
      hooks: [{ type: "command", command: "klaude hook session-start" }],
    },
  ],
  SessionEnd: [
    {
      hooks: [{ type: "command", command: "klaude hook session-end" }],
    },
  ],
};

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.warn(`Warning: Could not read ${SETTINGS_PATH}, will create new file`);
  }
  return { permissions: { allow: [], deny: [], ask: [] }, hooks: {} };
}

function hookExists(hookList: Hook[], newHook: Hook): boolean {
  return hookList.some(
    (h) =>
      h.matcher === newHook.matcher &&
      h.hooks?.[0]?.command === newHook.hooks?.[0]?.command,
  );
}

function mergeHooks(existing: Record<string, Hook[]> = {}, newHooks: Record<string, Hook[]>): Record<string, Hook[]> {
  const merged: Record<string, Hook[]> = { ...existing };

  for (const [hookType, hookList] of Object.entries(newHooks)) {
    if (!merged[hookType]) {
      merged[hookType] = [];
    }

    for (const newHook of hookList) {
      if (!hookExists(merged[hookType], newHook)) {
        merged[hookType].push(newHook);
      }
    }
  }

  return merged;
}

export function setupHooks(): void {
  const settings = loadSettings();

  // Merge hooks
  if (!settings.hooks) {
    settings.hooks = {};
  }
  settings.hooks = mergeHooks(settings.hooks, KLAUDE_HOOKS);

  // Ensure directory exists
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write settings
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`✓ Klaude hooks installed to ${SETTINGS_PATH}`);
}

// Run when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupHooks();
}
