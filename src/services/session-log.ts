import { promises as fsp } from 'node:fs';
import type { SessionLogEvent } from '@/types/index.js';

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
  try {
    const content = await fsp.readFile(logPath, 'utf-8');
    if (content.length > 0) {
      const lines = content.split('\n');
      for (const line of lines) {
        if (line) handleLine(line);
      }
      position = Buffer.byteLength(content, 'utf-8');
    }
  } catch {
    // if not exists yet, start at 0 and wait
    position = 0;
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

  // To determine end-of-session, watch for specific events in appended lines
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
    const timer = setInterval(check, 200).unref();
  });
}
