import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { rekeyPending, type PendingByKey } from './app-shell-pending-attachments.js';

/**
 * Carry a composer's staged items to the new-task target the user selects
 * (#3408).
 *
 * Everything the session-less composer holds is keyed by
 * `(profileId, hostId, projectId)` since #3122 — the draft text, staged
 * attachments and staged quotes alike — and the workspace picker that changes
 * the project part sits directly under the composer. So choosing a Project
 * re-keys all three mid-composition, and what the user staged drops out of the
 * composer on that click. `ChatComposerRegion` moves the draft text; this moves
 * the buckets, on the same rule: the target the user arrives at holds what they
 * arrived with and nothing else.
 *
 * Keyed on the NEW-TASK key rather than the composer's active draft key, which
 * is `activeId ?? newTaskDraftKey`. A Session switch changes that active key
 * too, and a Session's staged attachments must stay with the Session they were
 * staged for — this must not follow the user there.
 *
 * A layout effect, so the move lands in the same commit that re-keyed the
 * bucket and the drawer never paints a frame of "nothing staged".
 *
 * `undefined` for a composer that can never host a new task — the quote
 * companion panel is keyed by its own panel id — where the key never changes
 * and there is nothing to carry.
 */
export function useNewTaskPendingCarry<T>(
  newTaskDraftKey: string | undefined,
  setPendingByKey: Dispatch<SetStateAction<PendingByKey<T>>>,
): void {
  const previousNewTaskDraftKey = useRef(newTaskDraftKey);
  useLayoutEffect(() => {
    const from = previousNewTaskDraftKey.current;
    previousNewTaskDraftKey.current = newTaskDraftKey;
    if (from === undefined || newTaskDraftKey === undefined) return;
    if (from === newTaskDraftKey) return;
    setPendingByKey((map) => rekeyPending(map, from, newTaskDraftKey));
  }, [newTaskDraftKey, setPendingByKey]);
}
