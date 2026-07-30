export interface ProjectLocation {
  path: string;
  isWorktree: boolean;
}

export interface ProjectRecord {
  id: string;
  /** Durable IDs absorbed by this project during conflict-safe relinking. */
  aliases?: string[];
  name: string;
  locations: ProjectLocation[];
  archivedAt?: number;
  available: boolean;
  preferredPath?: string;
}
