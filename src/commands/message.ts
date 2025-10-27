/**
 * Message command - send a message to a session
 */

import { CLIContext, CommandResult } from '@/types/index.js';
import { MESSAGE_WAIT_TIMEOUT } from '@/config/constants.js';

interface MessageCommandOptions {
  sessionId: string;
  content: string;
  wait?: boolean;
  maxWaitMs?: number;
}

/**
 * Execute message command
 */
export async function messageCommand(options: MessageCommandOptions, context: CLIContext): Promise<CommandResult> {
  const { sessionId, content, wait = false, maxWaitMs = MESSAGE_WAIT_TIMEOUT } = options;

  try {
    // Verify session exists
    const session = await context.sessionManager.getSession(sessionId);
    if (!session) {
      return {
        success: false,
        message: `Session ${sessionId} not found.`,
      };
    }

    // Enqueue message
    const fromSessionId = context.activeSessionId;
    if (!fromSessionId) {
      return {
        success: false,
        message: 'No active session. Cannot send message without a source session.',
      };
    }
    const message = await context.messageQueue.enqueue(fromSessionId, sessionId, content);

    // Log the message
    await context.logger.log(sessionId, 'user', content);

    if (!wait) {
      return {
        success: true,
        message: `Message sent to session ${sessionId}`,
        data: {
          messageId: message.id,
          targetSessionId: sessionId,
        },
      };
    }

    // Wait for agent to process and respond
    try {
      await context.agentManager.wait(sessionId, maxWaitMs);

      const updatedSession = await context.sessionManager.getSession(sessionId);
      return {
        success: true,
        message: `Message processed by session ${sessionId}`,
        data: {
          messageId: message.id,
          sessionStatus: updatedSession?.status,
          result: updatedSession?.result,
        },
      };
    } catch (timeoutError) {
      return {
        success: false,
        message: `Timeout waiting for session ${sessionId} to process message (${maxWaitMs}ms)`,
        data: {
          messageId: message.id,
          timedOut: true,
        },
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to send message: ${errorMessage}`,
    };
  }
}
