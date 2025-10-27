import {
  initializeDatabase,
  closeDatabase,
  getProjectByHash,
  getSessionById,
  createClaudeSessionLink,
  updateSessionClaudeLink,
  createEvent,
  markClaudeSessionEnded,
  getClaudeSessionLink,
} from '@/db/index.js';
import { KlaudeError } from '@/utils/error-handler.js';

export interface ClaudeHookPayload {
  session_id: string;
  transcript_path?: string;
  source?: string;
  cwd?: string;
  hook_event_name?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new KlaudeError(`Missing required environment variable: ${name}`, 'E_ENV_MISSING');
  }
  return value;
}

function requirePayloadSessionId(payload: ClaudeHookPayload): string {
  if (!payload.session_id) {
    throw new KlaudeError('Hook payload missing session_id', 'E_HOOK_PAYLOAD_INVALID');
  }
  return payload.session_id;
}

export async function handleSessionStartHook(payload: ClaudeHookPayload): Promise<void> {
  const projectHash = requireEnv('KLAUDE_PROJECT_HASH');
  const klaudeSessionId = requireEnv('KLAUDE_SESSION_ID');
  const claudeSessionId = requirePayloadSessionId(payload);

  await initializeDatabase();
  try {
    const project = getProjectByHash(projectHash);
    if (!project) {
      throw new KlaudeError(
        `Project hash ${projectHash} is not registered`,
        'E_PROJECT_NOT_REGISTERED',
      );
    }

    const session = getSessionById(klaudeSessionId);
    if (!session) {
      throw new KlaudeError(
        `Session ${klaudeSessionId} is not registered`,
        'E_SESSION_NOT_FOUND',
      );
    }

    if (session.project_id !== project.id) {
      throw new KlaudeError(
        `Session ${klaudeSessionId} does not belong to project ${projectHash}`,
        'E_SESSION_PROJECT_MISMATCH',
      );
    }

    createClaudeSessionLink(session.id, claudeSessionId, {
      transcriptPath: payload.transcript_path ?? null,
      source: payload.source ?? null,
    });

    updateSessionClaudeLink(session.id, claudeSessionId, payload.transcript_path ?? null);

    createEvent(
      'hook.session_start',
      project.id,
      session.id,
      JSON.stringify(payload),
    );
  } finally {
    closeDatabase();
  }
}

export async function handleSessionEndHook(payload: ClaudeHookPayload): Promise<void> {
  const projectHash = requireEnv('KLAUDE_PROJECT_HASH');
  const claudeSessionId = requirePayloadSessionId(payload);

  await initializeDatabase();
  try {
    const project = getProjectByHash(projectHash);
    if (!project) {
      throw new KlaudeError(
        `Project hash ${projectHash} is not registered`,
        'E_PROJECT_NOT_REGISTERED',
      );
    }

    const link = getClaudeSessionLink(claudeSessionId);
    if (!link) {
      throw new KlaudeError(
        `Claude session ${claudeSessionId} is not linked to a Klaude session`,
        'E_SESSION_LINK_NOT_FOUND',
      );
    }

    markClaudeSessionEnded(claudeSessionId);

    createEvent(
      'hook.session_end',
      project.id,
      link.klaude_session_id,
      JSON.stringify(payload),
    );
  } finally {
    closeDatabase();
  }
}
