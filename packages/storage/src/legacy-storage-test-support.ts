/**
 * Test-only constructors for seeding and exercising retired structured files.
 *
 * Production callers must use the canonical SQLite factories and lease-bound
 * facades. This subpath exists only for legacy import and compatibility tests.
 */
export { createDeepResearchStore as createLegacyDeepResearchStoreForTest } from './deep-research-store.js';
export {
  openInteractiveInteractionStoreForRead as openLegacyInteractiveInteractionStoreForReadForTest,
  openInteractiveInteractionStoreForWrite as openLegacyInteractiveInteractionStoreForWriteForTest,
} from './interaction-store.js';
export { createPlanReminderStore as createLegacyPlanReminderStoreForTest } from './plan-reminder-store.js';
export { createPlanStore as createLegacyPlanStoreForTest } from './plan-store.js';
export { createLegacyFileSessionStore as createLegacySessionStoreForTest } from './session-store.js';
export { createTaskLedgerStore as createLegacyTaskLedgerStoreForTest } from './task-ledger-store.js';
export { createTelemetryRepo as createLegacyTelemetryRepoForTest } from './telemetry-repo.js';
