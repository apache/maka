/**
 * Production interaction-store surface.
 *
 * Legacy file-backed open functions intentionally remain in the implementation
 * module for import and compatibility tests, but are not package exports.
 */
export {
  STORED_INTERACTION_OUTCOME_MAX_BYTES,
  STORED_INTERACTION_REQUEST_MAX_BYTES,
  InteractionStoreError,
  authenticateInteractionStoreReader,
  authenticateInteractionStoreWriter,
  closeSqliteInteractionStoreFacade,
  interactionLocator,
  openSqliteInteractiveInteractionStoreForRead,
  openSqliteInteractiveInteractionStoreForWrite,
} from './interaction-store.js';
export type {
  CommitInteractionOutcomeResult,
  EstablishInteractionRequestResult,
  InteractionIdentity,
  InteractionMutationFailureResult,
  InteractionRecord,
  InteractionStoreErrorCode,
  InteractionStoreReader,
  InteractionStoreWriter,
  InteractiveInteractionStoreReaderFacade,
  InteractiveInteractionStoreWriterFacade,
  PendingInteractionFilter,
  SqliteInteractionStoreOptions,
  StoredInteractionOutcome,
  StoredInteractionRequest,
} from './interaction-store.js';
