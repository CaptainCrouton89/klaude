/**
 * Project model - CRUD operations for projects table
 */

import { getDatabase } from '../database.js';
import type { Project } from '@/types/db.js';

/**
 * Create a new project record
 */
export function createProject(rootPath: string, projectHash: string): Project {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO projects (root_path, project_hash) VALUES (?, ?)'
  );
  stmt.run(rootPath, projectHash);

  return getProjectByHash(projectHash)!;
}

/**
 * Get project by project hash
 */
export function getProjectByHash(projectHash: string): Project | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM projects WHERE project_hash = ?');
  const result = stmt.get(projectHash) as Project | null;
  return result || null;
}

/**
 * Get project by ID
 */
export function getProjectById(id: number): Project | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
  const result = stmt.get(id) as Project | null;
  return result || null;
}

/**
 * Get project by root path
 */
export function getProjectByPath(rootPath: string): Project | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM projects WHERE root_path = ?');
  const result = stmt.get(rootPath) as Project | null;
  return result || null;
}

/**
 * Get all projects
 */
export function getAllProjects(): Project[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM projects ORDER BY created_at DESC');
  return stmt.all() as Project[];
}
