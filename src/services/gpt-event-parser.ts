/**
 * Event parsers for GPT runtimes (Codex and Cursor)
 */

type AgentRuntimeEvent =
  | { type: 'status'; status: 'starting' | 'running' | 'completed'; detail?: string }
  | { type: 'message'; messageType: string; payload: unknown; text?: string | null }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result?: unknown; stopReason?: string | null }
  | { type: 'claude-session'; sessionId: string; transcriptPath?: string | null }
  | { type: 'done'; status: 'done' | 'failed' | 'interrupted'; reason?: string };

/**
 * Extract text from Cursor event format
 */
function extractCursorText(event: Record<string, unknown>): string | null {
  const message = event.message;
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) {
          parts.push(text);
        }
      }
      if (parts.length > 0) {
        return parts.join('');
      }
    }
  }

  const delta = event.delta;
  if (delta && typeof delta === 'object') {
    const text = (delta as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) {
      return text;
    }
  }

  return null;
}

/**
 * Parse Codex CLI events (--json format)
 * Based on testing with Codex v0.63.0
 */
export function parseCodexEvent(event: Record<string, unknown>, type: string): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = [];

  switch (type) {
    case 'thread.started': {
      const threadId = typeof event.thread_id === 'string' ? event.thread_id : null;
      events.push({
        type: 'log',
        level: 'info',
        message: `Codex thread started: ${threadId ?? 'unknown'}`,
      });
      events.push({
        type: 'status',
        status: 'running',
        detail: 'Codex agent ready',
      });
      break;
    }
    case 'turn.started': {
      events.push({
        type: 'log',
        level: 'info',
        message: 'Codex turn started',
      });
      break;
    }
    case 'item.started': {
      const item = event.item as Record<string, unknown> | undefined;
      const itemType = typeof item?.type === 'string' ? item.type : 'unknown';
      const itemId = typeof item?.id === 'string' ? item.id : 'unknown';

      if (itemType === 'command_execution' && typeof item?.command === 'string') {
        events.push({
          type: 'log',
          level: 'info',
          message: `Executing: ${item.command}`,
        });
      } else if (itemType === 'agent_message') {
        events.push({
          type: 'log',
          level: 'info',
          message: `Agent message ${itemId} started`,
        });
      }

      events.push({
        type: 'message',
        messageType: `codex.item.${itemType}`,
        payload: event,
      });
      break;
    }
    case 'item.completed': {
      const item = event.item as Record<string, unknown> | undefined;
      const itemType = typeof item?.type === 'string' ? item.type : 'unknown';

      // Extract text from agent_message or reasoning items
      if ((itemType === 'agent_message' || itemType === 'reasoning') && typeof item?.text === 'string') {
        events.push({
          type: 'message',
          messageType: itemType === 'reasoning' ? 'codex.reasoning' : 'assistant',
          payload: event,
          text: item.text,
        });
      } else if (itemType === 'file_change' && Array.isArray(item?.changes)) {
        const changes = item.changes as Array<{ path: string; kind: string }>;
        const summary = changes.map(c => `${c.kind} ${c.path}`).join(', ');
        events.push({
          type: 'log',
          level: 'info',
          message: `File changes: ${summary}`,
        });
      } else if (itemType === 'command_execution') {
        const exitCode = typeof item?.exit_code === 'number' ? item.exit_code : null;
        const command = typeof item?.command === 'string' ? item.command : 'unknown';
        events.push({
          type: 'log',
          level: exitCode === 0 ? 'info' : 'error',
          message: `Command "${command}" ${exitCode === 0 ? 'succeeded' : `failed (exit ${exitCode})`}`,
        });
      }

      events.push({
        type: 'message',
        messageType: `codex.item.${itemType}`,
        payload: event,
      });
      break;
    }
    case 'turn.completed': {
      const tokensUsed = typeof event.tokens_used === 'number' ? event.tokens_used : null;
      if (tokensUsed) {
        events.push({
          type: 'log',
          level: 'info',
          message: `Turn completed (${tokensUsed} tokens)`,
        });
      }
      events.push({
        type: 'result',
        result: event,
        stopReason: null,
      });
      break;
    }
    default: {
      events.push({
        type: 'message',
        messageType: `codex.${type}`,
        payload: event,
      });
    }
  }

  return events;
}

/**
 * Parse Cursor CLI events (--output-format stream-json)
 */
export function parseCursorEvent(event: Record<string, unknown>, type: string): AgentRuntimeEvent[] {
  const subtype = typeof event.subtype === 'string' ? event.subtype : null;
  const events: AgentRuntimeEvent[] = [];

  switch (type) {
    case 'system': {
      const model = typeof event.model === 'string' ? event.model : null;
      const detail = model
        ? `cursor-agent system.${subtype ?? 'event'} (model=${model})`
        : `cursor-agent system.${subtype ?? 'event'}`;
      events.push({ type: 'log', level: 'info', message: detail });
      if (subtype === 'init') {
        events.push({
          type: 'status',
          status: 'running',
          detail: model ? `Cursor agent using ${model}` : 'Cursor agent ready',
        });
      }
      break;
    }
    case 'assistant':
    case 'assistant_partial': {
      const text = extractCursorText(event);
      const messageType = subtype ? `assistant.${subtype}` : 'assistant';
      events.push({
        type: 'message',
        messageType,
        payload: event,
        text,
      });
      break;
    }
    case 'tool_call':
    case 'tool_result': {
      const messageType = subtype ? `${type}.${subtype}` : type;
      events.push({
        type: 'message',
        messageType,
        payload: event,
      });
      break;
    }
    case 'result': {
      const stopReason =
        typeof event.stopReason === 'string' ? event.stopReason : null;
      events.push({
        type: 'result',
        result: event,
        stopReason,
      });
      break;
    }
    case 'error': {
      const errorMessage =
        typeof event.message === 'string'
          ? event.message
          : 'Cursor agent reported an error';
      events.push({
        type: 'error',
        message: errorMessage,
        stack: typeof event.stack === 'string' ? event.stack : undefined,
      });
      break;
    }
    default: {
      events.push({
        type: 'message',
        messageType: `cursor.${type}`,
        payload: event,
      });
    }
  }

  return events;
}

/**
 * Extract text from Gemini event format
 */
function extractGeminiText(event: Record<string, unknown>): string | null {
  // Try to extract from text field first
  if (typeof event.text === 'string' && event.text.length > 0) {
    return event.text;
  }

  // Try to extract from content (string or array)
  const content = event.content;

  // Content as string (most common for Gemini messages)
  if (typeof content === 'string' && content.length > 0) {
    return content;
  }

  // Content as array (structured format)
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        parts.push(text);
      }
    }
    if (parts.length > 0) {
      return parts.join('');
    }
  }

  // Try to extract from delta (streaming format)
  const delta = event.delta;
  if (delta && typeof delta === 'object') {
    const text = (delta as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) {
      return text;
    }
  }

  return null;
}

/**
 * Parse Gemini CLI events (--json format)
 * Handles: status, message, assistant, tool_call, tool_result, result, error
 */
export function parseGeminiEvent(event: Record<string, unknown>, type: string): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = [];

  switch (type) {
    case 'status': {
      const status = typeof event.status === 'string' ? event.status : null;
      const detail = typeof event.detail === 'string' ? event.detail : null;

      if (status === 'starting') {
        events.push({
          type: 'status',
          status: 'starting',
          detail: detail ?? 'Gemini agent starting',
        });
      } else if (status === 'running') {
        const model = typeof event.model === 'string' ? event.model : null;
        const message = model ? `Gemini agent using ${model}` : 'Gemini agent ready';
        events.push({
          type: 'status',
          status: 'running',
          detail: message,
        });
        events.push({
          type: 'log',
          level: 'info',
          message,
        });
      } else if (status === 'completed') {
        events.push({
          type: 'status',
          status: 'completed',
          detail: detail ?? 'Gemini agent completed',
        });
      } else {
        events.push({
          type: 'log',
          level: 'info',
          message: `Gemini status: ${status}${detail ? ` (${detail})` : ''}`,
        });
      }
      break;
    }

    case 'message': {
      const role = typeof event.role === 'string' ? event.role : null;
      // Try to extract text from multiple possible fields (message, content, etc.)
      const messagePayload = typeof event.message === 'string' ? event.message : null;
      const extractedText = extractGeminiText(event);
      const text = messagePayload || extractedText;

      events.push({
        type: 'message',
        messageType: role ? `gemini.message.${role}` : 'gemini.message',
        payload: event,
        text,
      });

      if (text) {
        events.push({
          type: 'log',
          level: 'info',
          message: `Message: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
        });
      }
      break;
    }

    case 'assistant': {
      const text = extractGeminiText(event);
      events.push({
        type: 'message',
        messageType: 'assistant',
        payload: event,
        text,
      });
      if (text) {
        events.push({
          type: 'log',
          level: 'info',
          message: `Assistant: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
        });
      }
      break;
    }

    case 'tool_call': {
      const toolName = typeof event.tool_name === 'string' ? event.tool_name : 'unknown';
      events.push({
        type: 'message',
        messageType: 'tool_call',
        payload: event,
      });
      events.push({
        type: 'log',
        level: 'info',
        message: `Tool call: ${toolName}`,
      });
      break;
    }

    case 'tool_result': {
      const toolName = typeof event.tool_name === 'string' ? event.tool_name : 'unknown';
      const result = typeof event.result === 'string' ? event.result : null;
      events.push({
        type: 'message',
        messageType: 'tool_result',
        payload: event,
      });
      const summary = result ? result.substring(0, 100) : 'completed';
      events.push({
        type: 'log',
        level: 'info',
        message: `Tool result from ${toolName}: ${summary}${result && result.length > 100 ? '...' : ''}`,
      });
      break;
    }

    case 'result': {
      const stopReason = typeof event.stop_reason === 'string' ? event.stop_reason : null;
      events.push({
        type: 'result',
        result: event,
        stopReason,
      });
      if (stopReason) {
        events.push({
          type: 'log',
          level: 'info',
          message: `Generation stopped: ${stopReason}`,
        });
      }
      break;
    }

    case 'error': {
      const errorMessage =
        typeof event.message === 'string'
          ? event.message
          : 'Gemini agent reported an error';
      const errorCode = typeof event.code === 'string' ? event.code : null;

      events.push({
        type: 'error',
        message: errorCode ? `${errorCode}: ${errorMessage}` : errorMessage,
        stack: typeof event.stack === 'string' ? event.stack : undefined,
      });

      events.push({
        type: 'log',
        level: 'error',
        message: `Error: ${errorCode ? `${errorCode}: ` : ''}${errorMessage}`,
      });
      break;
    }

    default: {
      events.push({
        type: 'message',
        messageType: `gemini.${type}`,
        payload: event,
      });
    }
  }

  return events;
}
