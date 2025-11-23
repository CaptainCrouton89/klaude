/**
 * Event recording for wrapper instance
 *
 * Handles recording session events to both the database and log files.
 */

import { createEvent } from '@/db/index.js';
import type { Project, KlaudeConfig } from '@/types/index.js';
import type { ProjectContext } from '@/services/project-context.js';
import { appendSessionEvent } from '@/utils/logger.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import { ensureLogFile } from './utils.js';

/**
 * Event recorder function type
 */
export type RecordSessionEvent = (
  sessionId: string,
  kind: string,
  payload: unknown,
) => Promise<void>;

/**
 * Create an event recorder function bound to a specific project context
 *
 * @param context - Project context containing project hash
 * @param projectRecord - Database project record
 * @param wrapperConfig - Wrapper configuration
 * @returns Event recorder function
 */
export function createEventRecorder(
  context: ProjectContext,
  projectRecord: Project,
  wrapperConfig: KlaudeConfig['wrapper'],
): RecordSessionEvent {
  const verboseLog = (message: string): void => {
    if (process.env.VERBOSE === '1') {
      console.log(message);
    }
  };

  return async function recordSessionEvent(
    sessionId: string,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    try {
      await createEvent(kind, projectRecord.id, sessionId, JSON.stringify(payload));
      verboseLog(`[event-recorded] kind=${kind}, sessionId=${sessionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[event-error] Failed to record event kind=${kind}: ${message}`);
      throw error;
    }

    const sessionLogPath = getSessionLogPath(
      context.projectHash,
      sessionId,
      wrapperConfig?.projectsDir,
    );
    await ensureLogFile(sessionLogPath);
    await appendSessionEvent(sessionLogPath, kind, payload);
  };
}
