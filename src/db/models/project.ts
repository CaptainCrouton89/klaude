import type { Project } from '@/types/db.js';
import { DatabaseError } from '@/utils/error-handler.js';
import { getDatabase } from '../database.js';

function mapRowToProject(row: unknown): Project {
  if (!row || typeof row !== 'object') {
    throw new DatabaseError('Invalid project row received from database');
  }
  const record = row as Record<string, unknown>;
  return {
    id: Number(record.id),
    root_path: String(record.root_path),
    project_hash: String(record.project_hash),
    created_at: String(record.created_at),
  };
}

export function getProjectByHash(projectHash: string): Project | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT id, root_path, project_hash, created_at
       FROM projects
       WHERE project_hash = ?`,
    );
    const row = stmt.get(projectHash);
    return row ? mapRowToProject(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to fetch project by hash: ${message}`);
  }
}

export function getProjectById(projectId: number): Project | null {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT id, root_path, project_hash, created_at
       FROM projects
       WHERE id = ?`,
    );
    const row = stmt.get(projectId);
    return row ? mapRowToProject(row) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to fetch project by id: ${message}`);
  }
}

export function createProject(rootPath: string, projectHash: string): Project {
  try {
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT INTO projects (root_path, project_hash)
       VALUES (?, ?)`,
    );
    insert.run(rootPath, projectHash);

    const stmt = db.prepare(
      `SELECT id, root_path, project_hash, created_at
       FROM projects
       WHERE project_hash = ?`,
    );
    const row = stmt.get(projectHash);
    if (!row) {
      throw new DatabaseError('Failed to retrieve newly created project');
    }
    return mapRowToProject(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to create project: ${message}`);
  }
}

export function listProjects(): Project[] {
  try {
    const db = getDatabase();
    const stmt = db.prepare(
      `SELECT id, root_path, project_hash, created_at
       FROM projects
       ORDER BY created_at DESC`,
    );
    const rows = stmt.all() as unknown[];
    return rows.map(mapRowToProject);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Unable to list projects: ${message}`);
  }
}
