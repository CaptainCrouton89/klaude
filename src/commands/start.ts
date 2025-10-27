/**
 * Start command - spawn a new agent
 */

import { CLIContext, CommandResult, AgentType, StartAgentOptions } from '@/types/index.js';

interface StartCommandOptions extends StartAgentOptions {
  agentType: AgentType;
  prompt: string;
  count?: number;
}

/**
 * Execute start command
 */
export async function startCommand(options: StartCommandOptions, context: CLIContext): Promise<CommandResult> {
  const { agentType, prompt, checkout, share, detach, count = 1 } = options;

  try {
    // Validate agent type
    const validTypes: AgentType[] = [
      'orchestrator',
      'planner',
      'programmer',
      'junior-engineer',
      'context-engineer',
      'senior-engineer',
      'library-docs-writer',
      'non-dev',
    ];

    if (!validTypes.includes(agentType)) {
      return {
        success: false,
        message: `Invalid agent type: ${agentType}. Valid types: ${validTypes.join(', ')}`,
      };
    }

    const sessionIds: string[] = [];

    // Spawn agents
    for (let i = 0; i < count; i++) {
      const agent = await context.agentManager.spawn(agentType, prompt, {
        checkout,
        share,
        detach,
      });

      sessionIds.push(agent.sessionId);

      // Log agent spawn
      await context.logger.log(
        agent.sessionId,
        'system',
        `Agent ${i + 1}/${count} spawned with ID: ${agent.sessionId}`
      );

      // If not detached, simulate streaming output (in real implementation, this would connect to actual agent)
      if (!detach) {
        await context.logger.log(agent.sessionId, 'assistant', 'Agent started and ready to process requests');
      }
    }

    // If checkout is enabled, activate first session
    if (checkout && sessionIds.length > 0) {
      await context.sessionManager.activateSession(sessionIds[0]);
    }

    const message =
      sessionIds.length === 1
        ? `Started ${agentType} agent: ${sessionIds[0]}`
        : `Started ${sessionIds.length} ${agentType} agents: ${sessionIds.join(', ')}`;

    return {
      success: true,
      message,
      sessionId: sessionIds[0],
      data: {
        sessionIds,
        count: sessionIds.length,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to start agent: ${errorMessage}`,
    };
  }
}
