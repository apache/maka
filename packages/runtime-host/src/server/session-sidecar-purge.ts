import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type { InteractiveTaskLedgerWriter } from '@maka/storage/task-ledger-authority';

export interface SessionSidecarPurgeAuthority {
  readonly artifacts: Pick<InteractiveArtifactStoreWriter, 'purgeSessionArtifacts'>;
  readonly taskLedger: Pick<InteractiveTaskLedgerWriter, 'purgeConversationTaskLedger'>;
  readonly purgeOperationalState: (sessionId: string) => Promise<void>;
}

export async function purgeSessionSidecars(
  authority: SessionSidecarPurgeAuthority,
  sessionId: string,
): Promise<void> {
  const outcomes = await Promise.allSettled([
    authority.artifacts.purgeSessionArtifacts(sessionId),
    authority.taskLedger.purgeConversationTaskLedger(sessionId),
    authority.purgeOperationalState(sessionId),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `Session ${sessionId} sidecars could not be purged`);
  }
}
