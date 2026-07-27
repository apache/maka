import type { SessionStore } from './session-store.js';
import type { ProjectCatalog } from './project-catalog.js';

export interface ProjectSessionMigrationResult {
  migrated: number;
  unchanged: number;
}

export async function migrateSessionProjects(input: {
  sessions: Pick<SessionStore, 'listForRecovery' | 'updateHeader'>;
  catalog: Pick<ProjectCatalog, 'importLegacyPath'>;
}): Promise<ProjectSessionMigrationResult> {
  const headers = await input.sessions.listForRecovery();
  let migrated = 0;
  let unchanged = 0;

  for (const header of headers) {
    if (header.projectId) {
      unchanged++;
      continue;
    }
    const project = await input.catalog.importLegacyPath(header.cwd);
    await input.sessions.updateHeader(header.id, { projectId: project.id });
    migrated++;
  }

  return { migrated, unchanged };
}
