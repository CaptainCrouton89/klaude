/**
 * Checkout command - switch to a different session
 */

import { AgentType, CLIContext, CommandResult, SessionStatus } from '@/types/index.js';
import { scheduleSessionSwitch, SessionSwitchResult } from '@/utils/session-switcher.js';

interface CheckoutCommandOptions {
  sessionId?: string;
}

export interface CheckoutCommandData {
  session?: {
    id: string;
    claudeSessionId?: string;
    agentType: AgentType;
    status: SessionStatus;
    createdAt: Date;
    promptPreview: string;
  };
  switch: SessionSwitchResult;
}

/**
 * Execute checkout command
 */
export async function checkoutCommand(options: CheckoutCommandOptions, context: CLIContext): Promise<CommandResult> {
  try {
    const activeSessionId = await context.sessionManager.getActiveSessionId();
    const callerSession = activeSessionId ? await context.sessionManager.getSession(activeSessionId) : null;
    let targetSessionId = options.sessionId;
    let targetSession: Awaited<ReturnType<typeof context.sessionManager.getSession>> | null = null;

    // If no session ID provided, use parent session
    if (!targetSessionId) {
      if (!callerSession) {
        return {
          success: false,
          message: 'No active session found. Please specify a session ID.',
        };
      }

      if (!callerSession.parentSessionId) {
        return {
          success: false,
          message: 'No parent session to checkout to.',
        };
      }

      targetSessionId = callerSession.parentSessionId;
      targetSession = await context.sessionManager.getSession(targetSessionId);
    } else {
      targetSession = await context.sessionManager.getSession(targetSessionId);
      if (!targetSession) {
        const byClaudeId = await context.sessionManager.getSessionByClaudeId(targetSessionId);
        if (!byClaudeId) {
          return {
            success: false,
            message: `Session ${targetSessionId} not found.`,
          };
        }
        targetSessionId = byClaudeId.id;
        targetSession = byClaudeId;
      }
    }

    if (targetSession && callerSession && !targetSession.parentSessionId && targetSession.id !== callerSession.id) {
      await context.sessionManager.updateSession(targetSession.id, { parentSessionId: callerSession.id });
      targetSession = await context.sessionManager.getSession(targetSession.id);
    }

    let resumeSessionId: string | null = null;
    let sessionMetadata: CheckoutCommandData['session'] | undefined;

    if (targetSession) {
      // Activate the session so subsequent commands know the context
      await context.sessionManager.activateSession(targetSessionId);
      await context.logger.log(targetSessionId, 'system', `Checked out to session ${targetSessionId}`);

      resumeSessionId = targetSession.claudeSessionId ?? targetSessionId;
      sessionMetadata = {
        id: targetSession.id,
        claudeSessionId: targetSession.claudeSessionId,
        agentType: targetSession.agentType,
        status: targetSession.status,
        createdAt: targetSession.createdAt,
        promptPreview: targetSession.prompt.substring(0, 100),
      };
    } else if (targetSessionId) {
      // Fall back to resuming by the provided identifier even if Klaude has no record
      resumeSessionId = targetSessionId;
    }

    if (!resumeSessionId) {
      return {
        success: false,
        message: 'Unable to determine session to resume.',
      };
    }

    const switchResult = await scheduleSessionSwitch(resumeSessionId);

    const data: CheckoutCommandData = {
      session: sessionMetadata,
      switch: switchResult,
    };

    let message: string;
    if (targetSession) {
      const resumeLabel =
        resumeSessionId === targetSessionId ? targetSessionId : `${resumeSessionId} (klaude ${targetSessionId})`;
      message = `Switching to Claude session: ${resumeLabel}`;
    } else {
      message = `Switching to external Claude session: ${resumeSessionId}`;
    }

    return {
      success: true,
      message,
      sessionId: targetSession?.id,
      data,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to checkout session: ${errorMessage}`,
    };
  }
}
