/**
 * Hook command - process Claude Code hook payloads
 */

import { AgentType, CLIContext, CommandResult, Session, SessionStatus } from '@/types/index.js';

interface HookCommandOptions {
  event: string;
  rawPayload: string;
}

interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  reason?: string;
  source?: string;
  transcript_path?: string;
  parse_error?: string;
  [key: string]: unknown;
}

const DEFAULT_AGENT_TYPE: AgentType = 'orchestrator';
const DEFAULT_PROMPT = 'Claude session tracked via hook';

/**
 * Entrypoint for the hook command.
 */
export async function hookCommand(options: HookCommandOptions, context: CLIContext): Promise<CommandResult> {
  const payload = parsePayload(options.rawPayload);
  if (!payload.session_id) {
    return {
      success: false,
      message: payload.parse_error
        ? `Hook payload missing session_id (parse error: ${payload.parse_error})`
        : 'Hook payload missing session_id',
    };
  }

  const normalizedEvent = normalizeEvent(options.event ?? payload.hook_event_name ?? '');
  switch (normalizedEvent) {
    case 'session-start':
      return handleSessionStart(context, payload);
    case 'session-end':
      return handleSessionEnd(context, payload);
    default:
      return {
        success: false,
        message: `Unsupported hook event: ${options.event}`,
      };
  }
}

function parsePayload(raw: string): HookPayload {
  if (!raw || !raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as HookPayload;
  } catch (error) {
    return {
      parse_error: error instanceof Error ? error.message : String(error),
    } as HookPayload;
  }
}

function normalizeEvent(event: string): string {
  return event.trim().toLowerCase();
}

async function handleSessionStart(context: CLIContext, payload: HookPayload): Promise<CommandResult> {
  const claudeSessionId = payload.session_id!;
  const existing = await context.sessionManager.getSessionByClaudeId(claudeSessionId);

  let session: Session;
  if (existing) {
    session = existing;
  } else {
    session = await context.sessionManager.createSession(DEFAULT_AGENT_TYPE, DEFAULT_PROMPT);
  }

  const existingMetadata = { ...(session.metadata ?? {}) } as Record<string, unknown>;
  const metadata: Record<string, unknown> = {
    ...existingMetadata,
    hookSource:
      typeof payload.source === 'string'
        ? payload.source
        : (existingMetadata['hookSource'] as string | undefined) ?? 'unknown',
    transcriptPath:
      typeof payload.transcript_path === 'string'
        ? payload.transcript_path
        : (existingMetadata['transcriptPath'] as string | undefined),
    lastHookEvent: 'SessionStart',
    lastHookAt: new Date().toISOString(),
  };

  await context.sessionManager.updateSession(session.id, {
    claudeSessionId: claudeSessionId,
    status: 'running',
    metadata,
  });

  await context.sessionManager.activateSession(session.id);
  await context.logger.log(session.id, 'system', 'SessionStart hook processed – Klaude session activated.');

  return {
    success: true,
    message: `Session ${session.id} linked to Claude session ${claudeSessionId}`,
    sessionId: session.id,
  };
}

async function handleSessionEnd(context: CLIContext, payload: HookPayload): Promise<CommandResult> {
  const claudeSessionId = payload.session_id!;
  const session = await context.sessionManager.getSessionByClaudeId(claudeSessionId);

  if (!session) {
    return {
      success: true,
      message: `No Klaude session found for Claude session ${claudeSessionId}, skipping.`,
    };
  }

  const reason = payload.reason ?? 'unknown';
  const existingMetadata = { ...(session.metadata ?? {}) } as Record<string, unknown>;
  const metadata: Record<string, unknown> = {
    ...existingMetadata,
    lastHookEvent: 'SessionEnd',
    lastHookAt: new Date().toISOString(),
    lastSessionEndReason: reason,
  };

  const status: SessionStatus = reason === 'clear' || reason === 'logout' ? 'completed' : session.status;

  await context.sessionManager.updateSession(session.id, {
    status,
    metadata,
    completedAt: new Date(),
  });
  await context.logger.log(session.id, 'system', `SessionEnd hook processed (reason: ${reason}).`);

  return {
    success: true,
    message: `Session ${session.id} marked as ${status} (reason: ${reason}).`,
    sessionId: session.id,
  };
}
