export type ProjectKind = 'git' | 'folder';

export interface ProjectLocation {
  path: string;
  branch?: string;
  isWorktree: boolean;
  addedAt: number;
  lastUsedAt: number;
}

export interface ProjectRecord {
  id: string;
  /** Durable IDs absorbed by this project during conflict-safe relinking. */
  aliases?: string[];
  name: string;
  kind: ProjectKind;
  locations: ProjectLocation[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  archivedAt?: number;
  available: boolean;
  preferredPath?: string;
}
