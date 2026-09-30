/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { SessionRemovePreviewResult } from '@maka/runtime-host/protocol';
import type { SettingsTasksCopy } from '../../../locales/settings-tasks-copy.js';

export type RemovalPreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly preview: SessionRemovePreviewResult }
  /** The Host could not say; the confirm still names the tasks and the count. */
  | { readonly kind: 'failed' };

export interface PurgeConfirmation {
  /** Frozen when the dialog opened: what the preview describes and the delete removes. */
  readonly sessionIds: readonly string[];
  /** Whether a filter or search narrowed the set, which changes the wording. */
  readonly narrowed: boolean;
  readonly preview: RemovalPreviewState;
}

export interface PurgeConfirmationController {
  open(sessionIds: readonly string[], narrowed: boolean): void;
  cancel(): void;
  /**
   * Closes the dialog and hands back the ids to delete — exactly the ones the
   * preview was asked about, whatever the list shows by now. Undefined while
   * the preview is still computing or when nothing is open.
   */
  confirm(): readonly string[] | undefined;
}

/**
 * The bulk-delete confirm as a small state machine, so the rules that matter —
 * which ids are deleted, and what a late or failed preview may change — hold
 * without a DOM.
 *
 * The set is frozen at `open`. A confirm names a number to a person, and a set
 * re-read afterwards could be larger than the one they agreed to. A preview
 * that settles after its dialog was cancelled, or after a newer one opened,
 * is dropped. A preview that fails leaves the dialog usable: the reader can
 * still cancel, or delete the tasks the title counts.
 */
export function createPurgeConfirmationController(deps: {
  /** Absent outside a Desktop composition; the preview then reports failure. */
  readonly previewRemovals?: (
    sessionIds: readonly string[],
  ) => Promise<SessionRemovePreviewResult>;
  readonly onChange: (confirmation: PurgeConfirmation | undefined) => void;
}): PurgeConfirmationController {
  let current: PurgeConfirmation | undefined;
  let generation = 0;
  const publish = (next: PurgeConfirmation | undefined) => {
    current = next;
    deps.onChange(next);
  };
  const settle = (opened: number, preview: RemovalPreviewState) => {
    if (opened !== generation || !current) return;
    publish({ ...current, preview });
  };

  return {
    open(sessionIds, narrowed) {
      generation += 1;
      const opened = generation;
      const frozen = [...sessionIds];
      publish({ sessionIds: frozen, narrowed, preview: { kind: 'loading' } });
      if (!deps.previewRemovals) {
        settle(opened, { kind: 'failed' });
        return;
      }
      void deps.previewRemovals(frozen).then(
        (preview) => settle(opened, { kind: 'ready', preview }),
        () => settle(opened, { kind: 'failed' }),
      );
    },
    cancel() {
      generation += 1;
      publish(undefined);
    },
    confirm() {
      if (!current || current.preview.kind === 'loading') return undefined;
      const { sessionIds } = current;
      generation += 1;
      publish(undefined);
      return sessionIds;
    },
  };
}

/** The confirm's wording; only the Host preview's own figures are stated. */
export function describePurgeConfirmation(
  confirmation: PurgeConfirmation,
  copy: SettingsTasksCopy,
  formatSize: (bytes: number) => string,
): { readonly title: string; readonly description: string } {
  const count = confirmation.sessionIds.length;
  const title = confirmation.narrowed
    ? copy.purgeShownConfirmTitle(count)
    : copy.purgeAllConfirmTitle(count);
  const { preview } = confirmation;
  const details =
    preview.kind === 'loading'
      ? [copy.purgePreviewLoading]
      : preview.kind === 'failed'
        ? // Nothing measured, so nothing promised — except what every delete
          // does regardless, which the reader still needs to know.
          [copy.purgePreviewFailed, copy.purgeSubtaskNote]
        : [
            copy.purgePreview(
              preview.preview.removedSubtaskCount,
              preview.preview.worktreeCount,
              formatSize(preview.preview.bytes),
            ),
            preview.preview.archivableSubtaskCount > 0
              ? copy.purgeArchivableNote(preview.preview.archivableSubtaskCount)
              : undefined,
          ];
  return {
    title,
    description: [copy.purgeConfirmBody, ...details].filter(Boolean).join(' '),
  };
}
