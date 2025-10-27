/**
 * Database entity types for Klaude session management
 */

/**
 * Project entity
 * Represents a unique project directory tracked by Klaude
 */
export interface Project {
  id: number;
  root_path: string;
  project_hash: string;
  created_at: string;
}

/**
 * Instance entity
 * Represents a single Klaude wrapper process instance running for a project
 */
export interface Instance {
  instance_id: string;
  project_id: number;
  pid: number;
  tty: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  metadata_json: string | null;
}

/**
 * Session entity
 * Represents a session in the Klaude tree (TUI, SDK agent, or worker)
 */
export interface Session {
  id: string;
  project_id: number;
  parent_id: string | null;
  agent_type: 'tui' | 'sdk' | 'worker';
  instance_id: string | null;
  title: string | null;
  prompt: string | null;
  status: 'active' | 'running' | 'done' | 'failed' | 'interrupted';
  created_at: string;
  updated_at: string | null;
  ended_at: string | null;
  last_claude_session_id: string | null;
  last_transcript_path: string | null;
  current_process_pid: number | null;
  metadata_json: string | null;
}

/**
 * Claude session link entity
 * Links native Claude session IDs to Klaude sessions
 */
export interface ClaudeSessionLink {
  id: number;
  klaude_session_id: string;
  claude_session_id: string;
  transcript_path: string | null;
  source: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * Runtime process entity
 * Tracks active processes (wrapper, Claude child, SDK runtime)
 */
export interface RuntimeProcess {
  id: number;
  klaude_session_id: string;
  pid: number;
  kind: 'wrapper' | 'claude' | 'sdk';
  started_at: string;
  exited_at: string | null;
  exit_code: number | null;
  is_current: 0 | 1;
}

/**
 * Event entity
 * Audit log of all significant events in session lifecycle
 */
export interface Event {
  id: number;
  project_id: number | null;
  klaude_session_id: string | null;
  kind: string;
  payload_json: string | null;
  created_at: string;
}
