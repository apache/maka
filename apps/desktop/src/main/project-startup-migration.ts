import { migrateSessionProjects } from '@maka/storage';
import type { ProjectCatalog, SessionStore } from '@maka/storage';

export async function runProjectStartupMigration(deps: {
  sessions: Pick<SessionStore, 'listHeaders' | 'updateHeader'>;
  catalog: Pick<ProjectCatalog, 'importLegacyPath'>;
  emitSessionsChanged?(reason: 'migrated'): void;
  logError(message: string, error?: unknown): void;
}): Promise<void> {
  try {
    const result = await migrateSessionProjects({
      sessions: deps.sessions,
      catalog: deps.catalog,
    });
    if (result.failed > 0) {
      deps.logError(`[projects] skipped ${result.failed} legacy session migration(s)`);
    }
    if (result.migrated > 0) deps.emitSessionsChanged?.('migrated');
  } catch (error) {
    deps.logError('[projects] legacy session migration failed:', error);
  }
}
