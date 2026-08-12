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

export function findProjectByIdentity<
  T extends { readonly id: string; readonly aliases?: readonly string[] },
>(projects: readonly T[], identity: string): T | undefined {
  return projects.find((project) => project.id === identity || project.aliases?.includes(identity));
}
