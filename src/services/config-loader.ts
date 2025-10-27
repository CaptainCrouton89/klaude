/**
 * Configuration loading and initialization
 */

import { KlaudeConfig } from '@/types/index.js';
import { getConfigFilePath, getKlaudeHome } from '@/utils/path-helper.js';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { DEFAULT_CONFIG } from '@/config/defaults.js';
import path from 'path';

/**
 * Load configuration from file, or create default if missing
 */
export async function loadConfig(): Promise<KlaudeConfig> {
  const configPath = getConfigFilePath();

  // If config doesn't exist, create it with defaults
  if (!existsSync(configPath)) {
    await initializeDirectory();
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed = yaml.load(content);

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Config file must contain a YAML object');
    }

    const partial = parsed as Partial<KlaudeConfig>;

    // Merge with defaults to fill in any missing keys
    return mergeConfig(DEFAULT_CONFIG, partial);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`Invalid YAML in config file ${configPath}, using defaults`);
    } else if (error instanceof Error) {
      console.warn(`Failed to load config from ${configPath}: ${error.message}`);
    } else {
      console.warn(`Failed to load config from ${configPath}, using defaults`);
    }
    return DEFAULT_CONFIG;
  }
}

/**
 * Save configuration to file
 */
export async function saveConfig(config: KlaudeConfig): Promise<void> {
  const configPath = getConfigFilePath();
  const configDir = path.dirname(configPath);

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const content = yaml.dump(config, { indent: 2 });
  await fs.writeFile(configPath, content, 'utf-8');
}

/**
 * Initialize ~/.klaude directory structure
 */
export async function initializeDirectory(): Promise<void> {
  const klaudeHome = getKlaudeHome();

  const directories = [
    klaudeHome,
    path.join(klaudeHome, 'logs'),
    path.join(klaudeHome, 'cache'),
  ];

  for (const dir of directories) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Create config file if it doesn't exist
  const configPath = getConfigFilePath();
  if (!existsSync(configPath)) {
    const content = yaml.dump(DEFAULT_CONFIG, { indent: 2 });
    await fs.writeFile(configPath, content, 'utf-8');
  }
}

/**
 * Merge partial config with defaults
 */
function mergeConfig(defaults: KlaudeConfig, partial: Partial<KlaudeConfig>): KlaudeConfig {
  const sdkConfig = { ...defaults.sdk };
  if (partial.sdk) {
    Object.assign(sdkConfig, partial.sdk);
  }

  const sessionConfig = { ...defaults.session };
  if (partial.session) {
    Object.assign(sessionConfig, partial.session);
  }

  const serverConfig = { ...defaults.server };
  if (partial.server) {
    Object.assign(serverConfig, partial.server);
  }

  return {
    sdk: sdkConfig as KlaudeConfig['sdk'],
    session: sessionConfig as KlaudeConfig['session'],
    server: serverConfig as KlaudeConfig['server'],
  };
}

/**
 * Update a specific config value
 */
export async function updateConfig(updates: Partial<KlaudeConfig>): Promise<KlaudeConfig> {
  const current = await loadConfig();
  const merged = mergeConfig(current, updates);
  await saveConfig(merged);
  return merged;
}

/**
 * Get a specific config value
 */
export async function getConfigValue(keyPath: string): Promise<unknown> {
  const config = await loadConfig();
  const keys = keyPath.split('.');

  let current: unknown = config;
  for (const key of keys) {
    if (typeof current === 'object' && current !== null && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return current;
}
