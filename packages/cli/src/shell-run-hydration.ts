import { isActiveShellRunStatus } from '@maka/core/shell-run';
import {
  ShellRunUpdateBuffer,
  mergeShellRunUpdate,
  projectShellRunUpdateForSession,
} from '@maka/core/shell-run-result';
import { type ShellRunUpdate } from '@maka/core/events';
import type { MakaSessionDriver } from './session-driver.js';

export interface ShellRunHydrationController {
  reset(): void;
  hydrate(sessionId: string): Promise<void>;
  dispose(): void;
}

export function createShellRunHydrationController(input: {
  driver: Pick<MakaSessionDriver, 'getSessionId'>;
  applyToTranscript: (update: ShellRunUpdate, options?: { announceSettle?: boolean }) => boolean;
  listShellRunUpdates?: (sessionId: string) => Promise<ShellRunUpdate[]>;
  subscribeShellRunUpdates?: (listener: (update: ShellRunUpdate) => void) => () => void;
  onViewChanged: () => void;
  isClosed: () => boolean;
}): ShellRunHydrationController {
  let ownerMappings: ShellRunUpdate[] = [];
  let hydratingFor: string | undefined;
  let hydrationEpoch = 0;
  let hydrationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingUpdates = new ShellRunUpdateBuffer('cli.pi-tui-hydration-buffer');

  const applyViewUpdate = (
    candidate: ShellRunUpdate,
    options?: { announceSettle?: boolean },
  ): boolean => {
    const index = ownerMappings.findIndex(
      (update) =>
        update.sessionId === candidate.sessionId &&
        update.sourceToolCallId === candidate.sourceToolCallId,
    );
    const merged = mergeShellRunUpdate(
      index >= 0 ? ownerMappings[index] : undefined,
      candidate,
      'cli.pi-tui-runner',
    );
    const retainOwnerMapping =
      merged.update.ownership.kind === 'source_owned' &&
      isActiveShellRunStatus(merged.update.result.status);
    if (index >= 0 && retainOwnerMapping) ownerMappings[index] = merged.update;
    else if (index >= 0) ownerMappings.splice(index, 1);
    else if (retainOwnerMapping) ownerMappings.push(merged.update);
    return input.applyToTranscript(merged.update, options);
  };

  const replayPendingUpdates = (sessionId: string): boolean => {
    const buffered = pendingUpdates.drain();
    for (const update of buffered.updates) {
      const projected = projectShellRunUpdateForSession(sessionId, ownerMappings, update);
      for (const viewUpdate of projected) applyViewUpdate(viewUpdate);
    }
    return buffered.overflowed;
  };

  const reset = (): void => {
    ownerMappings = [];
    hydrationEpoch += 1;
    if (hydrationRetryTimer !== undefined) clearTimeout(hydrationRetryTimer);
    hydrationRetryTimer = undefined;
    hydratingFor = undefined;
    pendingUpdates.clear();
  };

  const runHydration = async (
    sessionId: string,
    epoch: number,
    retryDelayMs = 250,
  ): Promise<void> => {
    try {
      const updates = await input.listShellRunUpdates?.(sessionId);
      if (input.isClosed() || epoch !== hydrationEpoch || input.driver.getSessionId() !== sessionId)
        return;
      // Catch-up replays durable state, not a live event: flip cards silently.
      // Updates buffered from the live subscription during the await are
      // genuinely live and stay announceable in the drain below.
      for (const update of updates ?? []) applyViewUpdate(update, { announceSettle: false });
      const overflowed = replayPendingUpdates(sessionId);
      input.onViewChanged();
      if (overflowed) {
        void runHydration(sessionId, epoch);
        return;
      }
      hydratingFor = undefined;
    } catch {
      if (input.isClosed() || epoch !== hydrationEpoch || input.driver.getSessionId() !== sessionId)
        return;
      hydrationRetryTimer = setTimeout(() => {
        hydrationRetryTimer = undefined;
        void runHydration(sessionId, epoch, Math.min(retryDelayMs * 2, 5_000));
      }, retryDelayMs);
    }
  };

  const unsubscribe = input.subscribeShellRunUpdates?.((update) => {
    const sessionId = input.driver.getSessionId();
    if (input.isClosed() || !sessionId) return;
    if (hydratingFor === sessionId) {
      pendingUpdates.add(update);
      return;
    }
    const projected = projectShellRunUpdateForSession(sessionId, ownerMappings, update);
    let changed = false;
    for (const viewUpdate of projected) {
      if (applyViewUpdate(viewUpdate)) changed = true;
    }
    if (changed) input.onViewChanged();
  });

  return {
    reset,
    async hydrate(sessionId) {
      hydratingFor = sessionId;
      await runHydration(sessionId, hydrationEpoch);
    },
    dispose() {
      unsubscribe?.();
      reset();
    },
  };
}
