import { AgentDefinition } from './agent-definitions.js';
import { RuntimeKind, GptRuntimePreference, KlaudeConfig } from '@/types/index.js';

export interface RuntimeSelectionResult {
  runtime: RuntimeKind;
  fallbackRuntime?: RuntimeKind;
  reason: string;
}

/**
 * Determines which runtime to use for an agent based on model and configuration
 */
export class RuntimeSelector {
  constructor(private config: KlaudeConfig) {}

  /**
   * Select the appropriate runtime for an agent
   */
  selectRuntime(
    definition: AgentDefinition | null,
    modelOverride?: string,
  ): RuntimeSelectionResult {
    const model = modelOverride ?? definition?.model;

    // No model specified → default to Claude
    if (!model) {
      return {
        runtime: 'claude',
        reason: 'No model specified, using Claude runtime',
      };
    }

    const normalized = model.trim().toLowerCase();

    // Claude models → claude runtime
    if (this.isClaudeModel(normalized)) {
      return {
        runtime: 'claude',
        reason: `Model ${model} identified as Claude model`,
      };
    }

    // GPT models → determine which GPT runtime
    if (this.isGptModel(normalized)) {
      return this.selectGptRuntime(definition, model);
    }

    // Gemini models → gemini runtime with cursor fallback
    if (this.isGeminiModel(normalized)) {
      return {
        runtime: 'gemini',
        fallbackRuntime: 'cursor',
        reason: `Model ${model} identified as Gemini model (Cursor fallback)`,
      };
    }

    // Unknown model → default to Claude
    return {
      runtime: 'claude',
      reason: `Unknown model ${model}, defaulting to Claude`,
    };
  }

  private isClaudeModel(normalized: string): boolean {
    return (
      normalized.includes('sonnet') ||
      normalized.includes('opus') ||
      normalized.includes('haiku') ||
      normalized === 'sonnet' ||
      normalized === 'opus' ||
      normalized === 'haiku' ||
      normalized.includes('claude')
    );
  }

  private isGptModel(normalized: string): boolean {
    return (
      normalized.startsWith('gpt-') ||
      normalized.startsWith('o1-') ||
      normalized.startsWith('o3-') ||
      normalized.includes('composer-')
    );
  }

  private isGeminiModel(normalized: string): boolean {
    return normalized.includes('gemini');
  }

  private selectGptRuntime(
    definition: AgentDefinition | null,
    model: string,
  ): RuntimeSelectionResult {
    const gptConfig = this.config.wrapper?.gpt;

    // 1. Explicit runtime hint in agent definition (highest priority)
    if (definition?.runtime) {
      const runtime = definition.runtime === 'codex' ? 'codex' : 'cursor';
      return {
        runtime,
        fallbackRuntime: this.getFallbackRuntime(runtime, gptConfig?.fallbackOnError),
        reason: `Agent definition specifies ${runtime} runtime`,
      };
    }

    // 2. User config preference
    const preference = gptConfig?.preferredRuntime ?? 'auto';

    if (preference === 'auto') {
      // Auto mode: try codex first, cursor as fallback
      return {
        runtime: 'codex',
        fallbackRuntime: 'cursor',
        reason: 'Auto mode: preferring Codex with Cursor fallback',
      };
    }

    // 3. Use preferred runtime
    const runtime = preference === 'codex' ? 'codex' : 'cursor';
    return {
      runtime,
      fallbackRuntime: this.getFallbackRuntime(runtime, gptConfig?.fallbackOnError),
      reason: `Using configured preference: ${runtime}`,
    };
  }

  private getFallbackRuntime(
    primary: RuntimeKind,
    fallbackEnabled?: boolean,
  ): RuntimeKind | undefined {
    if (!fallbackEnabled) return undefined;

    if (primary === 'codex') return 'cursor';
    if (primary === 'cursor') return 'codex';
    return undefined;
  }
}
