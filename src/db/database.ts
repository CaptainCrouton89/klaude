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
  throw new Error('Not implemented');
}
