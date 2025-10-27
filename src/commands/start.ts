/**
 * Start command - spawn a new agent
 */

import { CLIContext, CommandResult, AgentType, StartAgentOptions, SessionStatus } from '@/types/index.js';

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
    const sessionSummaries: Array<{ sessionId: string; status: SessionStatus; result?: string }> = [];
    const errors: string[] = [];
    let overallSuccess = true;

    const writeStream = (type: 'stdout' | 'stderr', prefix: string, content: string): void => {
      const target = type === 'stderr' ? console.error : console.log;
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (line.length === 0) {
          target(prefix);
        } else {
          target(`${prefix}${line}`);
        }
      }
    };

    // Spawn agents sequentially so streaming output is readable
    for (let i = 0; i < count; i++) {
      const prefixRef = { value: '' };
      let agentError: Error | null = null;
      let latestResult: string | undefined;

      const spawnOptions: StartAgentOptions = {
        checkout,
        share,
        detach,
      };

      if (!detach) {
        spawnOptions.onStream = ({ type, content }) => {
          if (!content) {
            return;
          }
          const prefix = prefixRef.value;
          if (type === 'error') {
            writeStream('stderr', prefix, content);
          } else {
            writeStream('stdout', prefix, content);
          }
        };
      }

      spawnOptions.onError = error => {
        agentError = error;
        if (!detach) {
          const prefix = prefixRef.value;
          const messageText = error.message || 'Agent encountered an error';
          writeStream('stderr', prefix, messageText);
        }
      };

      spawnOptions.onComplete = ({ result }) => {
        latestResult = result;
      };

      const agent = await context.agentManager.spawn(agentType, prompt, spawnOptions);
      prefixRef.value = count > 1 ? `[${agent.sessionId}] ` : '';
      sessionIds.push(agent.sessionId);

      if (!detach) {
        try {
          await context.agentManager.wait(agent.sessionId);
        } catch (waitError) {
          if (!agentError) {
            agentError = waitError instanceof Error ? waitError : new Error(String(waitError));
          }
        }
      }

      const session = await context.sessionManager.getSession(agent.sessionId);
      if (session) {
        const summary = {
          sessionId: session.id,
          status: session.status as SessionStatus,
          result: session.result ?? latestResult,
        };
        sessionSummaries.push(summary);

        if (session.status === 'failed') {
          overallSuccess = false;
          const failureText = summary.result ?? agentError?.message ?? 'Agent execution failed';
          errors.push(failureText);
        }
      } else {
        overallSuccess = false;
        const failureText = agentError?.message ?? 'Session record could not be retrieved';
        sessionSummaries.push({
          sessionId: agent.sessionId,
          status: 'failed',
          result: failureText,
        });
        errors.push(failureText);
      }
    }

    // If checkout is enabled, activate first session
    if (checkout && sessionIds.length > 0) {
      await context.sessionManager.activateSession(sessionIds[0]);
    }

    const data = {
      sessionIds,
      sessions: sessionSummaries,
      errors,
      count: sessionIds.length,
      detached: detach,
    };

    if (overallSuccess) {
      const action = detach ? 'Started' : 'Completed';
      const message =
        sessionIds.length === 1
          ? `${action} ${agentType} agent: ${sessionIds[0]}${detach ? ' (detached)' : ''}`
          : `${action} ${sessionIds.length} ${agentType} agents: ${sessionIds.join(', ')}${detach ? ' (detached)' : ''}`;

      return {
        success: true,
        message,
        sessionId: sessionIds[0],
        data,
      };
    }

    const failureMessage = errors[0] ?? 'Agent execution failed';
    const message =
      sessionIds.length === 1
        ? `Agent ${sessionIds[0]} failed: ${failureMessage}`
        : `One or more ${agentType} agents failed: ${failureMessage}`;

    return {
      success: false,
      message,
      sessionId: sessionIds[0],
      data,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to start agent: ${errorMessage}`,
    };
  }
}
