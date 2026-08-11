import type { SessionSummary } from '@maka/core/session';

/** Stable Desktop IPC result for the one import failure that must not be retried blindly. */
export type ExternalSessionImportIpcResult =
  | { readonly ok: true; readonly session: SessionSummary }
  | { readonly ok: false; readonly reason: 'commit_outcome_unknown' };
