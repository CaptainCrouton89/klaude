/**
 * SQLite database implementation using better-sqlite3 for shared on-disk access.
 * Maintains a single connection per process while relying on WAL mode for
 * cross-process concurrency (hooks, wrapper instances, CLI commands).
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import DatabaseConstructor, {
  type Database as BetterSqliteDatabase,
  type Statement as BetterSqliteStatement,
} from 'better-sqlite3';

import { getDbPath } from '@/utils/path-helper.js';

/**
 * Database statement wrapper exposing the minimal interface used by the data layer.
 */
class DatabaseStatement {
  constructor(private stmt: BetterSqliteStatement) {}

  run(...params: unknown[]): { changes: number } {
    try {
      const result = this.stmt.run(...(params as Parameters<typeof this.stmt.run>));
      return { changes: typeof result.changes === 'number' ? result.changes : 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute statement: ${message}`);
    }
  }

  get(...params: unknown[]): unknown {
    try {
      return this.stmt.get(...(params as Parameters<typeof this.stmt.get>)) ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch row: ${message}`);
    }
  }

  all(...params: unknown[]): unknown[] {
    try {
      return this.stmt.all(...(params as Parameters<typeof this.stmt.all>));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch rows: ${message}`);
    }
  }
}

/**
 * Thin wrapper over better-sqlite3 to provide the previous sql.js-style API.
 */
class Database {
  constructor(private db: BetterSqliteDatabase) {}

  prepare(sql: string): DatabaseStatement {
    try {
      return new DatabaseStatement(this.db.prepare(sql));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare statement: ${message}`);
    }
  }

  run(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute SQL: ${message}`);
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute batch SQL: ${message}`);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to close database: ${message}`);
    }
  }
}

let dbInstance: Database | null = null;

/**
 * Initialize and return the shared database connection.
 */
export async function initializeDatabase(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  try {
    const dbPath = getDbPath();
    const dbDir = path.dirname(dbPath);

    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const sqliteDb = new DatabaseConstructor(dbPath, {
      fileMustExist: false,
      timeout: 5000,
    });

    // Enable WAL + tuned sync level up front for every connection.
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('synchronous = NORMAL');

    dbInstance = new Database(sqliteDb);
    initializeSchema(dbInstance);
    return dbInstance;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize database: ${message}`);
  }
}

/**
 * Return the active database connection or throw if it has not been initialized.
 */
export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbInstance;
}

/**
 * Close the database connection for the current process.
 */
export function closeDatabase(): void {
  if (!dbInstance) {
    return;
  }

  try {
    dbInstance.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error closing database: ${message}`);
  } finally {
    dbInstance = null;
  }
}

/**
 * Create database schema and indexes if they do not exist.
 */
function initializeSchema(db: Database): void {
  try {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');

    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        project_hash TEXT NOT NULL UNIQUE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        instance_id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pid INTEGER NOT NULL,
        tty TEXT,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        exit_code INTEGER,
        metadata_json TEXT
      );
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_instances_project ON instances(project_id);');

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        agent_type TEXT NOT NULL,
        instance_id TEXT REFERENCES instances(instance_id) ON DELETE SET NULL,
        title TEXT,
        prompt TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        ended_at DATETIME,
        last_claude_session_id TEXT,
        last_transcript_path TEXT,
        current_process_pid INTEGER,
        metadata_json TEXT
      );
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_instance ON sessions(instance_id);');

    db.exec(`
      CREATE TABLE IF NOT EXISTS claude_session_links (
        id INTEGER PRIMARY KEY,
        klaude_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        claude_session_id TEXT NOT NULL UNIQUE,
        transcript_path TEXT,
        source TEXT,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME
      );
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_csl_klaude ON claude_session_links(klaude_session_id);');

    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_process (
        id INTEGER PRIMARY KEY,
        klaude_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        pid INTEGER NOT NULL,
        kind TEXT NOT NULL,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        exited_at DATETIME,
        exit_code INTEGER,
        is_current INTEGER NOT NULL DEFAULT 0
      );
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_runtime_klaude ON runtime_process(klaude_session_id);');

    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        klaude_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        payload_json TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize database schema: ${message}`);
  }
}

