/**
 * Published operational-state-store surface.
 *
 * The owning module also exports the schema-migration internals; those run
 * against a caller-supplied database and stay package-private, exactly as the
 * deleted barrel kept them.
 */
export {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
  OPERATIONAL_STATE_SCHEMA_VERSION,
  resolveOperationalStateDatabasePath,
} from './operational-state-store.js';
export type {
  OperationalStateDatabaseLease,
  OperationalStateDatabaseOptions,
} from './operational-state-store.js';
