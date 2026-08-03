/**
 * Production interaction-store surface.
 *
 * The facade is backed by the canonical operational SQLite database.
 */
export {
  STORED_INTERACTION_OUTCOME_MAX_BYTES,
  STORED_INTERACTION_REQUEST_MAX_BYTES,
  InteractionStoreError,
  authenticateInteractionStoreReader,
  authenticateInteractionStoreWriter,
  closeSqliteInteractionStoreFacade,
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
  StoredInteractionOutcome,
  StoredInteractionRequest,
} from './interaction-store.js';
