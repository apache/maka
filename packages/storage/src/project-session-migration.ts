import type { SessionStore } from './session-store.js';
import type { ProjectCatalog } from './project-catalog.js';

export interface ProjectSessionMigrationResult {
  migrated: number;
  unchanged: number;
  failed: number;
}

export async function migrateSessionProjects(input: {
  sessions: Pick<SessionStore, 'listHeaders' | 'updateHeader'>;
  catalog: Pick<ProjectCatalog, 'importLegacyPath'>;
}): Promise<ProjectSessionMigrationResult> {
  const headers = await input.sessions.listHeaders();
  let migrated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const header of headers) {
    if (header.projectId !== undefined) {
      unchanged++;
      continue;
    }
    try {
      const project = await input.catalog.importLegacyPath(
        header.cwd,
        header.lastMessageAt ?? header.lastUsedAt,
      );
      await input.sessions.updateHeader(header.id, { projectId: project.id });
      migrated++;
    } catch {
      failed++;
    }
  }

  return { migrated, unchanged, failed };
}
