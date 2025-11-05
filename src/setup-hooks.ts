#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

const BUILTIN_AGENTS = [
  'programmer.md',
  'junior-engineer.md',
  'context-engineer.md',
  'senior-architect.md',
];

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
  PostToolUse: [
    {
      matcher: "*",
      hooks: [{ type: "command", command: "klaude hook post-tool-use-updates" }],
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

function promptUser(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function copyBuiltinAgents(): void {
  // Get the path to built-in agents (in the npm package)
  const builtinAgentsDir = path.join(__dirname, '..', '..', 'agents');

  // Create agents directory if it doesn't exist
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }

  let copiedCount = 0;
  let skippedCount = 0;

  for (const agent of BUILTIN_AGENTS) {
    const src = path.join(builtinAgentsDir, agent);
    const dest = path.join(AGENTS_DIR, agent);

    // Only copy if source exists and destination doesn't
    if (fs.existsSync(src)) {
      if (fs.existsSync(dest)) {
        console.log(`  ⊘ ${agent} (already exists, skipping)`);
        skippedCount++;
      } else {
        fs.copyFileSync(src, dest);
        console.log(`  ✓ ${agent}`);
        copiedCount++;
      }
    }
  }

  if (copiedCount > 0) {
    console.log(`\n✓ Copied ${copiedCount} built-in agent(s) to ${AGENTS_DIR}`);
  }
  if (skippedCount > 0) {
    console.log(`  (${skippedCount} agent(s) already exist)`);
  }
}

export async function setupHooks(): Promise<void> {
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

  // Prompt to copy built-in agents
  console.log('\nWould you like to install built-in agents?');
  console.log('This will copy example agents (programmer, junior-engineer, context-engineer, senior-architect)');
  console.log('to your ~/.claude/agents directory.\n');

  const shouldCopy = await promptUser('Install built-in agents? These agents include both anthropic and cursor-agents, and demonstrate the power of the klaude cli. If installed, the md files will be copied to your ~/.claude/agents directory. Install?(yes/no) ');

  if (shouldCopy) {
    console.log('\nCopying built-in agents:');
    copyBuiltinAgents();
  } else {
    console.log('Skipped agent installation.');
  }
}

// Run when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupHooks().catch((error) => {
    console.error('Error during setup:', error);
    process.exit(1);
  });
}
