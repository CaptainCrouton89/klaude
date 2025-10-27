/**
 * Checkout command - switch to a different session
 */

import { CLIContext, CommandResult } from '@/types/index.js';

interface CheckoutCommandOptions {
  sessionId?: string;
}

/**
 * Execute checkout command
 */
export async function checkoutCommand(options: CheckoutCommandOptions, context: CLIContext): Promise<CommandResult> {
  try {
    let targetSessionId = options.sessionId;

    // If no session ID provided, use parent session
    if (!targetSessionId) {
      const currentSessionId = await context.sessionManager.getActiveSessionId();
      if (!currentSessionId) {
        return {
          success: false,
          message: 'No active session found. Please specify a session ID.',
        };
      }

      const session = await context.sessionManager.getSession(currentSessionId);
      if (!session || !session.parentSessionId) {
        return {
          success: false,
          message: 'No parent session to checkout to.',
        };
      }

      targetSessionId = session.parentSessionId;
    }

    // Verify target session exists
    const targetSession = await context.sessionManager.getSession(targetSessionId);
    if (!targetSession) {
      return {
        success: false,
        message: `Session ${targetSessionId} not found.`,
      };
    }

    // Activate the session
    await context.sessionManager.activateSession(targetSessionId);

    // Log checkout
    await context.logger.log(targetSessionId, 'system', `Checked out to session ${targetSessionId}`);

    // Get session info for display
    const sessionMetadata = {
      id: targetSession.id,
      agentType: targetSession.agentType,
      status: targetSession.status,
      createdAt: targetSession.createdAt,
      prompt: targetSession.prompt.substring(0, 100),
    };

    return {
      success: true,
      message: `Checked out to session: ${targetSessionId}`,
      sessionId: targetSessionId,
      data: sessionMetadata,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to checkout session: ${errorMessage}`,
    };
  }
}
