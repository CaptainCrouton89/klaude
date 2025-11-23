import { exec } from 'child_process';
import { promisify } from 'util';
import { KlaudeConfig } from '@/types/index.js';

const execAsync = promisify(exec);

export interface RuntimeValidationResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

/**
 * Validates availability of runtime binaries (Codex, Cursor)
 */
export class RuntimeValidator {
  /**
   * Check if Codex CLI is installed and available
   */
  static async validateCodex(binaryPath = 'codex'): Promise<RuntimeValidationResult> {
    try {
      const { stdout } = await execAsync(`${binaryPath} --version`);
      return {
        available: true,
        version: stdout.trim(),
        path: binaryPath,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if Cursor CLI is installed
   */
  static async validateCursor(binaryPath = 'cursor-agent'): Promise<RuntimeValidationResult> {
    try {
      const { stdout } = await execAsync(`${binaryPath} --version`);
      return {
        available: true,
        version: stdout.trim(),
        path: binaryPath,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if Gemini CLI is installed and available
   */
  static async validateGemini(binaryPath = 'gemini'): Promise<RuntimeValidationResult> {
    try {
      const { stdout } = await execAsync(`${binaryPath} --version`);
      return {
        available: true,
        version: stdout.trim(),
        path: binaryPath,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate all GPT runtimes and return available options
   */
  static async validateGptRuntimes(config: KlaudeConfig): Promise<{
    codex: RuntimeValidationResult;
    cursor: RuntimeValidationResult;
    gemini: RuntimeValidationResult;
  }> {
    const gptConfig = config.wrapper?.gpt;

    const [codex, cursor, gemini] = await Promise.all([
      this.validateCodex(gptConfig?.codex?.binaryPath),
      this.validateCursor(gptConfig?.cursor?.binaryPath),
      this.validateGemini(gptConfig?.gemini?.binaryPath),
    ]);

    return { codex, cursor, gemini };
  }
}
