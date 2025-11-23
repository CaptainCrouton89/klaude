import { promises as fsp } from 'node:fs';
import type { SessionLogEvent } from '@/types/index.js';

/**
 * Completion information extracted from a session log
 */
export interface SessionCompletionInfo {
  status: 'done' | 'failed' | 'interrupted' | 'unknown';
  filesEdited: string[];
  filesCreated: string[];
  finalText?: string;
  error?: string;
}

/**
 * Tail a session log file, printing assistant messages to stdout.
 * Supports both raw (raw JSON) and filtered (assistant text only) modes.
 * Can optionally stop when terminal events are detected.
 */
export async function tailSessionLog(
  logPath: string,
  options: { untilExit: boolean; raw?: boolean },
): Promise<void> {
  // State for pretty printing assistant text only
  const raw = Boolean(options.raw);
  let printedStream = false;

  // To determine end-of-session, check for specific events
  const isTerminalEvent = (line: string): boolean => {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.kind === 'string') {
        const k = obj.kind as string;
        return (
          k === 'agent.runtime.done' ||
          k === 'agent.runtime.process.exited' ||
          k === 'wrapper.finalized' ||
          k === 'wrapper.claude.exited'
        );
      }
    } catch {}
    return false;
  };

  const handleLine = (line: string): void => {
    if (raw) {
      process.stdout.write(line + '\n');
      return;
    }
    try {
      const obj = JSON.parse(line) as SessionLogEvent;
      if (obj.kind === 'agent.runtime.message') {
        const payload = obj.payload as { messageType?: string; text?: string } | undefined;
        const mt = payload?.messageType;
        const text = typeof payload?.text === 'string' ? payload.text : '';
        if (mt === 'stream_event') {
          if (text) {
            process.stdout.write(text);
            printedStream = true;
          }
          return;
        }
        if (mt === 'assistant') {
          if (!printedStream && text) {
            process.stdout.write(text + '\n');
          }
          return;
        }
      }
      if (obj.kind === 'agent.runtime.result') {
        if (printedStream) {
          process.stdout.write('\n');
          printedStream = false;
        }
        return;
      }
    } catch {
      // ignore parse errors in non-verbose mode
    }
  };

  // Print existing content first (filtered)
  let position = 0;
  let foundTerminalEvent = false;
  try {
    const content = await fsp.readFile(logPath, 'utf-8');
    if (content.length > 0) {
      const lines = content.split('\n');
      for (const line of lines) {
        if (line) {
          handleLine(line);
          if (options.untilExit && isTerminalEvent(line)) {
            foundTerminalEvent = true;
          }
        }
      }
      position = Buffer.byteLength(content, 'utf-8');
    }
  } catch {
    // if not exists yet, start at 0 and wait
    position = 0;
  }

  // If session is already complete, print completion message and return
  if (foundTerminalEvent) {
    if (!raw) {
      console.log('\n✅ Session completed');
    }
    return;
  }

  const { watch } = await import('node:fs');
  let closing = false;
  const stop = () => {
    if (!closing) {
      closing = true;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const readChunk = async (): Promise<void> => {
    try {
      const fh = await (await import('node:fs/promises')).open(logPath, 'r');
      const stat = await fh.stat();
      if (stat.size > position) {
        const length = stat.size - position;
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, position);
        position = stat.size;
        fh.close().catch(() => {});
        const text = buffer.toString('utf-8');
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line) continue;
          handleLine(line);
          if (options.untilExit && isTerminalEvent(line)) {
            stop();
          }
        }
      } else {
        fh.close().catch(() => {});
      }
    } catch (err) {
      // ignore until file appears again
    }
  };

  await readChunk();

  const watcher = watch(logPath, { persistent: true });
  await new Promise<void>((resolve) => {
    watcher.on('change', async () => {
      if (closing) return;
      await readChunk();
      if (closing) {
        watcher.close();
        resolve();
      }
    });
    watcher.on('rename', async () => {
      // file rotated/recreated
      await readChunk();
      if (closing) {
        watcher.close();
        resolve();
      }
    });
    // Poll every 250ms in case change events are coalesced
    const timer = setInterval(async () => {
      if (closing) {
        clearInterval(timer);
        watcher.close();
        resolve();
        return;
      }
      await readChunk();
      if (closing) {
        clearInterval(timer);
        watcher.close();
        resolve();
      }
    }, 250).unref();
  });
}

/**
 * Print a summary of a session log including event counts, timestamps, and resume IDs.
 */
export async function printSessionSummary(logPath: string): Promise<void> {
  const content = await fsp.readFile(logPath, 'utf-8');
  if (!content.trim()) {
    console.log('(log is empty)');
    return;
  }
  const lines = content.split('\n').filter(Boolean);
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let agentType: string | null = null;
  let totalEvents = 0;
  let messages = 0;
  let results = 0;
  let errors = 0;
  let lastText: string | null = null;
  const resumeIds = new Set<string>();

  for (const line of lines) {
    totalEvents++;
    try {
      const obj = JSON.parse(line) as SessionLogEvent;
      if (obj.timestamp) {
        if (!createdAt) createdAt = obj.timestamp;
        updatedAt = obj.timestamp;
      }
      switch (obj.kind) {
        case 'agent.session.created': {
          const payload = obj.payload as { agentType?: string } | undefined;
          if (payload?.agentType) {
            agentType = payload.agentType;
          }
          break;
        }
        case 'agent.runtime.message': {
          messages++;
          const payload = obj.payload as { text?: string } | undefined;
          if (typeof payload?.text === 'string' && payload.text.trim()) {
            lastText = payload.text;
          }
          break;
        }
        case 'agent.runtime.result': {
          results++;
          const payload = obj.payload as { result?: string } | undefined;
          if (typeof payload?.result === 'string' && payload.result.trim()) {
            lastText = payload.result;
          }
          break;
        }
        case 'agent.runtime.error':
          errors++;
          break;
        case 'agent.runtime.claude-session': {
          const payload = obj.payload as { sessionId?: string } | undefined;
          if (typeof payload?.sessionId === 'string') {
            resumeIds.add(payload.sessionId);
          }
          break;
        }
        case 'wrapper.checkout.resume_selected': {
          const payload = obj.payload as { selectedResumeId?: string } | undefined;
          if (typeof payload?.selectedResumeId === 'string') {
            resumeIds.add(payload.selectedResumeId);
          }
          break;
        }
      }
    } catch {
      // ignore parse failures
    }
  }

  console.log(`agent: ${agentType ?? 'unknown'}`);
  console.log(`events: ${totalEvents}, messages: ${messages}, results: ${results}, errors: ${errors}`);
  if (createdAt) console.log(`created: ${createdAt}`);
  if (updatedAt) console.log(`updated: ${updatedAt}`);
  if (resumeIds.size > 0) console.log(`resume_ids: ${Array.from(resumeIds).join(', ')}`);
  if (lastText) console.log(`last_text: ${lastText}`);
}

/**
 * Print only assistant messages from a session log.
 */
export async function printAssistantTranscript(logPath: string): Promise<void> {
  const content = await fsp.readFile(logPath, 'utf-8');
  if (!content.trim()) {
    console.log('(log is empty)');
    return;
  }
  const lines = content.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as SessionLogEvent;
      if (obj.kind === 'agent.runtime.message') {
        const payload = obj.payload as { messageType?: string; text?: string } | undefined;
        const mt = payload?.messageType;
        const text = typeof payload?.text === 'string' ? payload.text : '';
        if (mt === 'assistant' && text) {
          console.log(text);
        }
      }
    } catch {
      // ignore parse errors
    }
  }
}

/**
 * Wait for first assistant output to appear in log file.
 * Returns true if output was found within the deadline, false otherwise.
 */
export async function waitForFirstAssistantOutput(logPath: string, waitSeconds: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  // Start from end of file
  let position = 0;
  try {
    const stat = await (await import('node:fs/promises')).stat(logPath);
    position = stat.size;
  } catch {}

  const { watch } = await import('node:fs');

  const isAssistantLine = (line: string): boolean => {
    try {
      const obj = JSON.parse(line) as SessionLogEvent;
      if (!obj || typeof obj !== 'object') return false;
      if (obj.kind === 'agent.runtime.message') {
        const payload = obj.payload as { messageType?: string } | undefined;
        const t = payload?.messageType;
        return t === 'assistant' || t === 'stream_event';
      }
      if (obj.kind === 'agent.runtime.result') return true;
    } catch {}
    return false;
  };

  const readChunk = async (): Promise<string[]> => {
    const chunks: string[] = [];
    try {
      const fh = await (await import('node:fs/promises')).open(logPath, 'r');
      const stat = await fh.stat();
      if (stat.size > position) {
        const length = stat.size - position;
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, position);
        position = stat.size;
        fh.close().catch(() => {});
        const text = buffer.toString('utf-8');
        for (const line of text.split('\n')) {
          if (line) chunks.push(line);
        }
      } else {
        fh.close().catch(() => {});
      }
    } catch {}
    return chunks;
  };

  // Quick pass in case something already landed
  for (const line of await readChunk()) {
    if (isAssistantLine(line)) {
      const obj = JSON.parse(line) as SessionLogEvent;
      const payload = obj.payload as { text?: string } | undefined;
      if (typeof payload?.text === 'string' && payload.text) {
        console.log(payload.text);
      }
      return true;
    }
  }

  const watcher = watch(logPath, { persistent: true });
  return await new Promise<boolean>((resolve) => {
    const check = async () => {
      if (Date.now() >= deadline) {
        watcher.close();
        resolve(false);
        return;
      }
      for (const line of await readChunk()) {
        if (isAssistantLine(line)) {
          try {
            const obj = JSON.parse(line) as SessionLogEvent;
            const payload = obj.payload as { text?: string } | undefined;
            if (typeof payload?.text === 'string' && payload.text) {
              console.log(payload.text);
            }
          } catch {}
          watcher.close();
          resolve(true);
          return;
        }
      }
    };
    watcher.on('change', check);
    watcher.on('rename', check);
    setInterval(check, 200).unref();
  });
}

/**
 * Collect completion information from a session log.
 * Extracts final status, file operations, last assistant message, and errors.
 * Returns structured data suitable for display in wait command.
 *
 * Best-effort parsing - swallows errors and returns partial data if log is incomplete.
 */
export async function collectCompletionInfo(logPath: string): Promise<SessionCompletionInfo> {
  const result: SessionCompletionInfo = {
    status: 'unknown',
    filesEdited: [],
    filesCreated: [],
  };

  let content: string;
  try {
    content = await fsp.readFile(logPath, 'utf-8');
  } catch {
    // Log file doesn't exist or can't be read
    return result;
  }

  if (!content.trim()) {
    return result;
  }

  const lines = content.split('\n').filter(Boolean);

  // Track seen file paths to avoid duplicates
  const editedSet = new Set<string>();
  const createdSet = new Set<string>();

  // Helper to check if event is terminal
  const isTerminal = (kind: string): boolean => {
    return (
      kind === 'agent.runtime.done' ||
      kind === 'agent.runtime.process.exited' ||
      kind === 'wrapper.finalized' ||
      kind === 'wrapper.claude.exited'
    );
  };

  // Helper to extract file path from tool use/result payload (best-effort)
  const extractFilePath = (payload: unknown): string | null => {
    if (!payload || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;

    // Try common field names for file paths
    for (const key of ['file_path', 'filePath', 'path', 'uri']) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }

    // Try nested parameters (tool_use events often have { name, input } structure)
    if (obj.input && typeof obj.input === 'object') {
      const input = obj.input as Record<string, unknown>;
      for (const key of ['file_path', 'filePath', 'path', 'uri']) {
        const val = input[key];
        if (typeof val === 'string' && val.trim()) {
          return val.trim();
        }
      }
    }

    return null;
  };

  // Helper to check if message type is assistant-like
  const isAssistantMessage = (messageType: string | undefined): boolean => {
    if (!messageType) return false;
    return (
      messageType === 'assistant' ||
      messageType.startsWith('assistant.') ||
      messageType === 'assistant_partial' ||
      messageType === 'gemini.message.assistant' ||
      messageType === 'codex.reasoning' ||
      messageType.endsWith('.assistant')
    );
  };

  // Parse events until terminal event
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as SessionLogEvent;

      // Stop at terminal events
      if (isTerminal(event.kind)) {
        if (event.kind === 'agent.runtime.done') {
          const payload = event.payload as { status?: string; reason?: string } | undefined;
          if (payload?.status === 'done') {
            result.status = 'done';
          } else if (payload?.status === 'failed') {
            result.status = 'failed';
          } else if (payload?.status === 'interrupted') {
            result.status = 'interrupted';
          }
          // If done event has a reason and status is failed/interrupted, capture it
          if (payload?.reason && result.status !== 'done' && !result.error) {
            result.error = payload.reason;
          }
        }
        break;
      }

      // Extract final assistant message and tool uses
      if (event.kind === 'agent.runtime.message') {
        const payload = event.payload as { messageType?: string; text?: string; payload?: unknown } | undefined;
        if (isAssistantMessage(payload?.messageType) && payload?.text?.trim()) {
          result.finalText = payload.text.trim();
        }

        // Extract file operations from tool calls (best-effort)
        // Claude SDK structure: payload.payload.message.content[] contains tool_use objects
        if (payload?.payload && typeof payload.payload === 'object') {
          const sdkPayload = payload.payload as Record<string, unknown>;
          const message = sdkPayload.message;
          if (message && typeof message === 'object') {
            const messageObj = message as Record<string, unknown>;
            const content = messageObj.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (item && typeof item === 'object') {
                  const contentItem = item as Record<string, unknown>;
                  if (contentItem.type === 'tool_use') {
                    const toolName = contentItem.name;
                    const toolInput = contentItem.input;
                    if (typeof toolName === 'string' && toolInput && typeof toolInput === 'object') {
                      const filePath = extractFilePath(toolInput);
                      if (filePath) {
                        if (toolName === 'Write') {
                          createdSet.add(filePath);
                        } else if (toolName === 'Edit') {
                          editedSet.add(filePath);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Also check agent.runtime.result for final text fallback
      if (event.kind === 'agent.runtime.result') {
        const payload = event.payload as { result?: string } | undefined;
        if (payload?.result?.trim()) {
          result.finalText = payload.result.trim();
        }
      }

      // Extract errors (priority order: agent.runtime.error, agent.runtime.process.error)
      // NOTE: We intentionally do NOT capture stderr as errors since many runtimes
      // (Gemini, Codex, Cursor) write informational messages to stderr (e.g.,
      // "YOLO mode enabled", "Loaded cached credentials", retry messages)
      if (event.kind === 'agent.runtime.error' && !result.error) {
        const payload = event.payload as { error?: string; message?: string } | undefined;
        const errorMsg = payload?.error || payload?.message;
        if (errorMsg?.trim()) {
          result.error = errorMsg.trim();
        }
      }

      if (event.kind === 'agent.runtime.process.error' && !result.error) {
        const payload = event.payload as { error?: string; message?: string } | undefined;
        const errorMsg = payload?.error || payload?.message;
        if (errorMsg?.trim()) {
          result.error = errorMsg.trim();
        }
      }
    } catch {
      // Ignore parse errors - best-effort
      continue;
    }
  }

  // Convert sets to arrays
  result.filesEdited = Array.from(editedSet).sort();
  result.filesCreated = Array.from(createdSet).sort();

  // If status is still unknown but we have a finalText, assume done
  if (result.status === 'unknown' && result.finalText) {
    result.status = 'done';
  }

  // If we have an error but status is unknown, mark as failed
  if (result.status === 'unknown' && result.error) {
    result.status = 'failed';
  }

  return result;
}
