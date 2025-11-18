import {
  closeDatabase,
  createClaudeSessionLink,
  createEvent,
  getClaudeSessionLink,
  getProjectByHash,
  getSessionById,
  initializeDatabase,
  markClaudeSessionEnded,
  updateSessionClaudeLink,
} from '@/db/index.js';
import { resolveSessionId } from '@/db/models/session.js';
import { loadConfig } from '@/services/config-loader.js';
import { KlaudeError } from '@/utils/error-handler.js';
import { appendSessionEvent } from '@/utils/logger.js';
import { getSessionLogPath } from '@/utils/path-helper.js';
import { promises as fsp } from 'node:fs';

async function debugLog(message: string, toStderr = true): Promise<void> {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;

  // Write to stderr immediately for visibility
  if (toStderr) {
    process.stderr.write(line + '\n');
  }

  // Write to persistent log
  try {
    await fsp.appendFile('/tmp/klaude-hook-session.log', line + '\n');
  } catch {
    // ignore write failures
  }
}

export interface ClaudeHookPayload {
  session_id: string;
  transcript_path?: string;
  source?: string;
  cwd?: string;
  hook_event_name?: string;
}

export interface PreUserMessagePayload {
  message?: string;
  prompt?: string;
  message_id?: string;
  timestamp?: string;
  session_id?: string;
  [key: string]: unknown;
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

export async function handleSessionStartHook(payload: ClaudeHookPayload): Promise<string> {
  const startTime = Date.now();

  // Check if we're in a klaude session; if not, gracefully exit
  if (!process.env.KLAUDE_PROJECT_HASH) {
    await debugLog('Not in a klaude session (KLAUDE_PROJECT_HASH not set); exiting gracefully');
    return '';
  }

  await debugLog('════════════════════════════════════════════════════════════');
  await debugLog('SESSION_START_HOOK INVOKED');
  await debugLog(`Timestamp: ${new Date().toISOString()}`);
  await debugLog(`PID: ${process.pid}`);
  await debugLog('════════════════════════════════════════════════════════════');

  // Log environment
  await debugLog(`Environment variables present:`);
  await debugLog(`  KLAUDE_PROJECT_HASH=${process.env.KLAUDE_PROJECT_HASH}`);
  await debugLog(`  KLAUDE_SESSION_ID=${process.env.KLAUDE_SESSION_ID}`);
  await debugLog(`  KLAUDE_INSTANCE_ID=${process.env.KLAUDE_INSTANCE_ID}`);
  await debugLog(`  HOME=${process.env.HOME}`);
  await debugLog(`  PWD=${process.cwd()}`);

  // Log payload
  await debugLog(`Payload received: ${JSON.stringify(payload, null, 2)}`);

  try {
    // Extract IDs
    await debugLog('Step 1: Extracting environment variables...');
    const projectHash = requireEnv('KLAUDE_PROJECT_HASH');
    await debugLog(`  ✓ KLAUDE_PROJECT_HASH=${projectHash}`);

    const klaudeSessionId = requireEnv('KLAUDE_SESSION_ID');
    await debugLog(`  ✓ KLAUDE_SESSION_ID=${klaudeSessionId}`);

    const claudeSessionId = requirePayloadSessionId(payload);
    await debugLog(`  ✓ Claude session_id=${claudeSessionId}`);

    // Initialize DB
    await debugLog('Step 2: Initializing database...');
    await initializeDatabase();
    await debugLog(`  ✓ Database initialized`);

    // Get project
    await debugLog('Step 3: Looking up project...');
    const project = getProjectByHash(projectHash);
    if (!project) {
      throw new KlaudeError(
        `Project hash ${projectHash} is not registered`,
        'E_PROJECT_NOT_REGISTERED',
      );
    }
    await debugLog(`  ✓ Found project: id=${project.id}, root_path=${project.root_path}`);

    // Get session - resolve abbreviated ID to full ID
    await debugLog('Step 4: Looking up Klaude session...');
    await debugLog(`  Resolving abbreviated session ID: ${klaudeSessionId}`);
    const fullSessionId = resolveSessionId(klaudeSessionId, project.id);
    await debugLog(`  ✓ Resolved to full ID: ${fullSessionId}`);
    const session = getSessionById(fullSessionId);
    if (!session) {
      throw new KlaudeError(
        `Session ${klaudeSessionId} is not registered`,
        'E_SESSION_NOT_FOUND',
      );
    }
    await debugLog(`  ✓ Found session: id=${session.id}, status=${session.status}`);

    // Verify session belongs to project
    await debugLog('Step 5: Verifying session-project relationship...');
    if (session.project_id !== project.id) {
      throw new KlaudeError(
        `Session ${klaudeSessionId} does not belong to project ${projectHash}`,
        'E_SESSION_PROJECT_MISMATCH',
      );
    }
    await debugLog(`  ✓ Session belongs to correct project`);

    // Handle Claude session link
    await debugLog('Step 6: Handling Claude session link...');
    const existingLink = getClaudeSessionLink(claudeSessionId);
    if (!existingLink) {
      await debugLog(`  Creating new link for Claude session ${claudeSessionId}`);
      createClaudeSessionLink(session.id, claudeSessionId, {
        transcriptPath: payload.transcript_path ?? null,
        source: payload.source ?? null,
      });
      await debugLog(`  ✓ Created new Claude session link`);
    } else {
      await debugLog(`  Claude session ${claudeSessionId} already linked`);
    }

    // Only update last_claude_session_id for startup sessions.
    // For resume sessions, keep the original session ID since Claude creates
    // a new UUID when resuming, but we want to refer to the original session.
    const isStartup = payload.source === 'startup' || payload.source === undefined;
    await debugLog(`Step 7: ${isStartup ? 'Updating' : 'Skipping update of'} session Claude link (source=${payload.source})...`);
    if (isStartup) {
      updateSessionClaudeLink(session.id, claudeSessionId, payload.transcript_path ?? null);
      await debugLog(`  ✓ Updated Claude link`);
    } else {
      await debugLog(`  ⊘ Skipped update for resume source`);
    }

    // Record event
    await debugLog('Step 8: Recording event to database...');
    await createEvent(
      'hook.session_start',
      project.id,
      session.id,
      JSON.stringify(payload),
    );
    await debugLog(`  ✓ Event recorded`);

    // Append to session log
    await debugLog('Step 9: Appending to session log file...');
    const config = await loadConfig();
    const logPath = getSessionLogPath(projectHash, session.id, config.wrapper?.projectsDir);
    await debugLog(`  Log path: ${logPath}`);
    await appendSessionEvent(logPath, 'hook.session_start', payload);
    await debugLog(`  ✓ Appended to log`);

    const elapsed = Date.now() - startTime;
    await debugLog(`════════════════════════════════════════════════════════════`);
    await debugLog(`✓ SESSION_START_HOOK COMPLETED (${elapsed}ms)`);
    await debugLog(`════════════════════════════════════════════════════════════`);

    // Inject welcome message explaining klaude usage
    const welcomeMessage = `The Task tool has been replaced with \`klaude\`. It's more powerful than the Task tool since the spawned agents are non-blocking; you can continue your own work while the agent works in the background. Always use klaude instead of the Task tool. Any agent type compatible with the Task tool is also compatible with klaude.

To delegate work to specialized agents, use:
  klaude start <agent-type> "<task description>"

Example:
  klaude start Explore "investigate authentication patterns"
  
Be proactive about using agents to delegate work. For complex or instruction-heavy tasks, investigating, planning, and even implementing can be improved by delegating and parallelizing. Begin by delegating agents for understanding the problem, then an agent for planning the solution, and finally an agent for each major component of the solution.`;

    const output = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: welcomeMessage,
      },
    };

    return JSON.stringify(output);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof KlaudeError ? error.code : 'UNKNOWN';
    const stack = error instanceof Error ? error.stack : '';

    await debugLog(`════════════════════════════════════════════════════════════`);
    await debugLog(`✗ SESSION_START_HOOK FAILED (${elapsed}ms)`);
    await debugLog(`Error code: ${code}`);
    await debugLog(`Error message: ${message}`);
    if (stack) {
      await debugLog(`Stack trace:\n${stack}`);
    }
    await debugLog(`════════════════════════════════════════════════════════════`);

    throw error;
  } finally {
    closeDatabase();
  }
}

export async function handleSessionEndHook(payload: ClaudeHookPayload): Promise<void> {
  const startTime = Date.now();

  // Check if we're in a klaude session; if not, gracefully exit
  if (!process.env.KLAUDE_PROJECT_HASH) {
    await debugLog('Not in a klaude session (KLAUDE_PROJECT_HASH not set); exiting gracefully');
    return;
  }

  await debugLog('════════════════════════════════════════════════════════════');
  await debugLog('SESSION_END_HOOK INVOKED');
  await debugLog(`Timestamp: ${new Date().toISOString()}`);
  await debugLog(`PID: ${process.pid}`);
  await debugLog('════════════════════════════════════════════════════════════');

  // Log environment
  await debugLog(`Environment variables present:`);
  await debugLog(`  KLAUDE_PROJECT_HASH=${process.env.KLAUDE_PROJECT_HASH}`);
  await debugLog(`  HOME=${process.env.HOME}`);
  await debugLog(`  PWD=${process.cwd()}`);

  // Log payload
  await debugLog(`Payload received: ${JSON.stringify(payload, null, 2)}`);

  try {
    await debugLog('Step 1: Extracting environment variables...');
    const projectHash = requireEnv('KLAUDE_PROJECT_HASH');
    await debugLog(`  ✓ KLAUDE_PROJECT_HASH=${projectHash}`);

    const claudeSessionId = requirePayloadSessionId(payload);
    await debugLog(`  ✓ Claude session_id=${claudeSessionId}`);

    await debugLog('Step 2: Initializing database...');
    await initializeDatabase();
    await debugLog(`  ✓ Database initialized`);

    await debugLog('Step 3: Looking up project...');
    const project = getProjectByHash(projectHash);
    if (!project) {
      throw new KlaudeError(
        `Project hash ${projectHash} is not registered`,
        'E_PROJECT_NOT_REGISTERED',
      );
    }
    await debugLog(`  ✓ Found project: id=${project.id}, root_path=${project.root_path}`);

    await debugLog('Step 4: Looking up Claude session link...');
    const link = getClaudeSessionLink(claudeSessionId);
    if (!link) {
      throw new KlaudeError(
        `Claude session ${claudeSessionId} is not linked to a Klaude session`,
        'E_SESSION_LINK_NOT_FOUND',
      );
    }
    await debugLog(`  ✓ Found link: klaude_session_id=${link.klaude_session_id}`);

    await debugLog('Step 5: Marking Claude session as ended...');
    markClaudeSessionEnded(claudeSessionId);
    await debugLog(`  ✓ Marked session ended`);

    await debugLog('Step 6: Recording event to database...');
    await createEvent(
      'hook.session_end',
      project.id,
      link.klaude_session_id,
      JSON.stringify(payload),
    );
    await debugLog(`  ✓ Event recorded`);

    await debugLog('Step 7: Appending to session log file...');
    const config = await loadConfig();
    const logPath = getSessionLogPath(projectHash, link.klaude_session_id, config.wrapper?.projectsDir);
    await debugLog(`  Log path: ${logPath}`);
    await appendSessionEvent(logPath, 'hook.session_end', payload);
    await debugLog(`  ✓ Appended to log`);

    const elapsed = Date.now() - startTime;
    await debugLog(`════════════════════════════════════════════════════════════`);
    await debugLog(`✓ SESSION_END_HOOK COMPLETED (${elapsed}ms)`);
    await debugLog(`════════════════════════════════════════════════════════════`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof KlaudeError ? error.code : 'UNKNOWN';
    const stack = error instanceof Error ? error.stack : '';

    await debugLog(`════════════════════════════════════════════════════════════`);
    await debugLog(`✗ SESSION_END_HOOK FAILED (${elapsed}ms)`);
    await debugLog(`Error code: ${code}`);
    await debugLog(`Error message: ${message}`);
    if (stack) {
      await debugLog(`Stack trace:\n${stack}`);
    }
    await debugLog(`════════════════════════════════════════════════════════════`);

    throw error;
  } finally {
    closeDatabase();
  }
}

export async function handlePreUserMessageHook(payload: PreUserMessagePayload): Promise<string> {
  // Check if we're in a klaude session; if not, return empty (allow through)
  if (!process.env.KLAUDE_PROJECT_HASH) {
    return '';
  }

  // Extract message text (can be in 'message' or 'prompt' field)
  const messageText = (typeof payload.prompt === 'string' ? payload.prompt :
                       typeof payload.message === 'string' ? payload.message : '');

  // Regex to detect @agent-<agent-name> pattern
  // Captures agent name like: @agent-planner, @agent-Explore, etc.
  const agentPattern = /@agent-([a-zA-Z0-9\-]+)/;
  const match = messageText.match(agentPattern);

  if (!match || !match[1]) {
    // No @agent- pattern found, pass through
    return '';
  }

  const agentName = match[1];

  // Generate JSON output for UserPromptSubmit hook with additionalContext
  // This injects the suggestion as context that Claude will see and process
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `<system-reminder>To use the ${agentName} agent, do not use the Task tool. Instead, run: \`klaude start ${agentName} "<your-prompt>"\`</system-reminder>`,
    },
  };

  return JSON.stringify(output);
}
