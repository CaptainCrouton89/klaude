#!/usr/bin/env node

/**
 * Agent runtime entry point. Reads configuration from stdin, invokes Claude Code
 * via the local CLI SDK, and streams structured events back to the wrapper over stdout.
 */

import { stdin, stdout, stderr, exit } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  Options as QueryOptions,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

type PermissionMode = QueryOptions['permissionMode'];

interface RuntimeInitPayload {
  sessionId: string;
  agentType: string;
  prompt: string;
  options?: {
    checkout?: boolean;
    share?: boolean;
    detach?: boolean;
  };
  metadata?: {
    projectHash?: string;
    projectRoot?: string;
    instanceId?: string;
    parentSessionId?: string | null;
    agentCount?: number | null;
  };
  sdk?: {
    model?: string | null;
    fallbackModel?: string | null;
    permissionMode?: PermissionMode | null;
  };
}

type OutboundEvent =
  | { type: 'status'; status: 'starting' | 'running' | 'completed'; detail?: string }
  | { type: 'message'; messageType: string; payload: unknown; text?: string | null }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result?: unknown; stopReason?: string | null }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'claude-session'; sessionId: string; transcriptPath?: string | null }
  | { type: 'done'; status: 'done' | 'failed' | 'interrupted'; reason?: string };

function emit(event: OutboundEvent): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

async function readRuntimeConfig(): Promise<RuntimeInitPayload> {
  if (stdin.isTTY) {
    throw new Error('Runtime config must be provided on stdin');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) {
    throw new Error('Runtime config payload is empty');
  }

  try {
    return JSON.parse(raw) as RuntimeInitPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse runtime config JSON: ${message}`);
  }
}

function expandClaudeQueryPath(): string {
  const claudeCliPath = path.join(homedir(), '.claude', 'claude-cli', 'sdk.mjs');
  return pathToFileURL(claudeCliPath).href;
}

function extractAssistantText(message: SDKAssistantMessage): string | null {
  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (item && typeof item === 'object' && 'text' in item) {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }

  return parts.length > 0 ? parts.join('') : null;
}

function extractPartialText(message: SDKPartialAssistantMessage): string | null {
  const event = message.event as { delta?: unknown; type?: string };
  if (event?.type === 'message_delta' && event.delta && typeof event.delta === 'object') {
    const delta = event.delta as { text?: string };
    if (typeof delta.text === 'string') {
      return delta.text;
    }
  }
  return null;
}

function extractResultText(message: SDKResultMessage): string | null {
  if ('result' in message && typeof message.result === 'string') {
    return message.result;
  }
  return null;
}

function extractMessageText(message: SDKMessage): string | null {
  switch (message.type) {
    case 'assistant':
      return extractAssistantText(message);
    case 'stream_event':
      return extractPartialText(message);
    case 'result':
      return extractResultText(message);
    default:
      return null;
  }
}

function buildQueryOptions(
  init: RuntimeInitPayload,
  abortController: AbortController,
): QueryOptions {
  const options: QueryOptions = {
    abortController,
    includePartialMessages: true,
    permissionMode: init.sdk?.permissionMode ?? 'bypassPermissions',
    model: init.sdk?.model ?? undefined,
    fallbackModel: init.sdk?.fallbackModel ?? undefined,
  };

  if (init.metadata?.projectRoot) {
    options.cwd = init.metadata.projectRoot;
  }

  return options;
}

async function run(): Promise<void> {
  const init = await readRuntimeConfig();

  if (!init.prompt || init.prompt.trim().length === 0) {
    throw new Error('Agent prompt is required');
  }

  const queryModule = await import(expandClaudeQueryPath());
  const queryFn = queryModule.query as (params: {
    prompt: string | AsyncIterable<SDKMessage>;
    options?: QueryOptions;
  }) => Query;

  const abortController = new AbortController();
  const options = buildQueryOptions(init, abortController);

  let announcedSessionId = false;
  let finished = false;

  const finalize = (status: 'done' | 'failed' | 'interrupted', reason?: string): void => {
    if (finished) {
      return;
    }
    finished = true;
    emit({ type: 'done', status, reason });
  };

  const handleInterrupt = (signal: NodeJS.Signals): void => {
    emit({ type: 'log', level: 'warn', message: `Received signal ${signal}, aborting agent` });
    abortController.abort();
    finalize('interrupted', signal);
  };

  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);

  emit({ type: 'status', status: 'starting' });

  let stream: Query;
  try {
    stream = queryFn({
      prompt: init.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message, stack: error instanceof Error ? error.stack : undefined });
    finalize('failed', message);
    throw error;
  }

  emit({ type: 'status', status: 'running' });

  try {
    for await (const message of stream) {
      if (!announcedSessionId && message.session_id) {
        emit({ type: 'claude-session', sessionId: message.session_id, transcriptPath: null });
        announcedSessionId = true;
      }

      const text = extractMessageText(message);
      emit({
        type: 'message',
        messageType: message.type,
        payload: message,
        text,
      });

      if (message.type === 'result') {
        const resultMessage = message as SDKResultMessage;
        const resultPayload = (resultMessage as { result?: unknown }).result ?? null;
        emit({
          type: 'result',
          result: resultPayload,
          stopReason: resultMessage.subtype,
        });
      }
    }

    emit({ type: 'status', status: 'completed' });
    finalize('done');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message, stack: error instanceof Error ? error.stack : undefined });
    finalize('failed', message);
    throw error;
  }
}

run()
  .then(() => exit(0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Agent runtime failed: ${message}\n`);
    exit(1);
  });
