/** Test-only construction seams for the SQLite Session store. */
export {
  createSessionStoreWithTestDependencies as createSessionStoreForTest,
  type SessionAuthorityStore,
} from './session-store.js';
