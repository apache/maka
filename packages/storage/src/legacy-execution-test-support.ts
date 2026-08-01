/**
 * Test-only constructors for seeding and exercising retired execution files.
 *
 * Production callers must use the canonical SQLite factories from
 * `@maka/storage`. Keeping these behind an explicit subpath prevents an
 * accidental root import from reviving a JSON/JSONL writer while preserving
 * legacy import and compatibility coverage.
 */
export {
  createAgentRunStore as createLegacyAgentRunStoreForTest,
  createRuntimeEventStore as createLegacyRuntimeEventStoreForTest,
} from './agent-run-store.js';
export { createShellRunStore as createLegacyShellRunStoreForTest } from './shell-run-store.js';
