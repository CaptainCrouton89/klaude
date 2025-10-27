/**
 * SQLite database implementation using sql.js with persistence to disk
 */

import { getDbPath } from '@/utils/path-helper.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import initSqlJs, { Database as SqlJsDatabase, Statement as SqlJsStatement } from 'sql.js';

/**
 * Database statement wrapper
 */
class DatabaseStatement {
  constructor(
    private stmt: SqlJsStatement,
    private db: SqlJsDatabase,
    private onSave?: () => void
  ) {}

  run(...params: unknown[]): { changes: number } {
    try {
      // Reset statement to clear any previous bindings
      this.stmt.reset();

      // Bind parameters
      this.stmt.bind(params as Parameters<typeof this.stmt.bind>[0]);

      // Execute the statement
      this.stmt.step();

      // Get changes before freeing
      const changes = this.db.getRowsModified();

      // Reset and free the statement
      this.stmt.reset();
      this.stmt.free();

      // Persist changes to disk if save callback provided
      if (this.onSave && changes > 0) {
        this.onSave();
      }

      return { changes };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute statement: ${errorMessage}`);
    }
  }

  get(...params: unknown[]): unknown {
    try {
      this.stmt.reset();
      this.stmt.bind(params as Parameters<typeof this.stmt.bind>[0]);
      const result = this.stmt.step() ? this.stmt.getAsObject() : null;
      this.stmt.reset();
      this.stmt.free();
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch row: ${errorMessage}`);
    }
  }

  all(...params: unknown[]): unknown[] {
    try {
      this.stmt.reset();
      this.stmt.bind(params as Parameters<typeof this.stmt.bind>[0]);
      const results: unknown[] = [];
      while (this.stmt.step()) {
        results.push(this.stmt.getAsObject());
      }
      this.stmt.reset();
      this.stmt.free();
      return results;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch rows: ${errorMessage}`);
    }
  }
}

/**
 * Database wrapper
 */
class Database {
  constructor(private db: SqlJsDatabase, private dbPath: string) {}

  prepare(sql: string): DatabaseStatement {
    try {
      const stmt = this.db.prepare(sql);
      // Return a statement that will save after execution
      return new DatabaseStatement(stmt, this.db, () => this.save());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare statement: ${errorMessage}`);
    }
  }

  run(sql: string): void {
    try {
      this.db.run(sql);
      this.save();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute SQL: ${errorMessage}`);
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
      this.save();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute batch SQL: ${errorMessage}`);
    }
  }

  private save(): void {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      writeFileSync(this.dbPath, buffer);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to save database: ${errorMessage}`);
    }
  }

  close(): void {
    try {
      this.save();
      this.db.close();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to close database: ${errorMessage}`);
    }
  }
}

let dbInstance: Database | null = null;
let sqlJsInstance: Awaited<ReturnType<typeof initSqlJs>> | null = null;

/**
 * Initialize and get database connection
 */
export async function initializeDatabase(): Promise<Database> {
  if (dbInstance) return dbInstance;

  try {
    const dbPath = getDbPath();
    const dbDir = path.dirname(dbPath);

    // Create directory if it doesn't exist
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize sql.js
    if (!sqlJsInstance) {
      sqlJsInstance = await initSqlJs();
    }

    // Load existing database or create new one
    let data: Uint8Array | undefined;
    if (existsSync(dbPath)) {
      data = new Uint8Array(readFileSync(dbPath));
    }

    const sqlJsDb = new sqlJsInstance.Database(data);
    dbInstance = new Database(sqlJsDb, dbPath);

    // Initialize schema
    initializeSchema(dbInstance);

    return dbInstance;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to initialize database: ${error.message}`);
    }
    throw new Error(`Failed to initialize database: ${String(error)}`);
  }
}

/**
 * Get existing database connection
 */
export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbInstance;
}

/**
 * Close database connection
 * Note: Errors during close are logged but not thrown to ensure graceful shutdown
 */
export function closeDatabase(): void {
  if (!dbInstance) {
    return;
  }

  try {
    dbInstance.close();
    dbInstance = null;
  } catch (error) {
    // Extract error message and log it
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fullMessage = `Error closing database: ${errorMessage}`;
    console.error(fullMessage);

    // Ensure we clear the instance even if close fails
    dbInstance = null;

    // Log but don't re-throw - graceful shutdown is more important than propagating close errors
  }
}

/**
 * Create database schema
 */
function initializeSchema(db: Database): void {
  const schema = `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      agent_type TEXT NOT NULL,
      parent_session_id TEXT REFERENCES sessions(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('created', 'running', 'completed', 'failed')),
      prompt TEXT DEFAULT '',
      result TEXT,
      metadata TEXT,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_session_id TEXT NOT NULL REFERENCES sessions(id),
      to_session_id TEXT NOT NULL REFERENCES sessions(id),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      FOREIGN KEY (from_session_id) REFERENCES sessions(id),
      FOREIGN KEY (to_session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS active_agents (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'interrupted', 'completed', 'failed')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent_type ON sessions(agent_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_from_session ON messages(from_session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_to_session ON messages(to_session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `;

  try {
    db.exec(schema);
  } catch (error) {
    // Tables might already exist - that's OK
    if (error instanceof Error && error.message.includes('already exists')) {
      return;
    }
    // Unknown error - re-throw with context
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize schema: ${errorMessage}`);
  }

  // Ensure claude_session_id column exists on existing databases
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (!error.message.includes('duplicate column name') && !error.message.includes('already exists'))
    ) {
      throw new Error(`Failed to ensure claude_session_id column: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_claude_session_id ON sessions(claude_session_id)');
  } catch (error) {
    if (error instanceof Error && (error.message.includes('already exists') || error.message.includes('duplicate index'))) {
      return;
    }
    if (error instanceof Error && error.message.includes('no such column')) {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to ensure idx_sessions_claude_session_id index: ${errorMessage}`);
  }
}
