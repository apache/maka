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

import { createText, UiError, errorText, type UiText, message as uiMessage } from './text';
import { tr } from './locale';
import { cleanup, signal } from 'nsh';
import { findUpload, recoverUpload, abandonUpload, watchUploads, type ScopedHost } from './host';
import type { ClientDraftAttachment } from '../../../../packages/plugin-sdk/src/index.js';

export type DraftAttachment = ClientDraftAttachment;
type AttachmentStatus = {
  operationId: string;
  kind: 'reading' | 'uploading' | 'failed' | 'complete';
  name: string;
  error?: string;
};
export type AttachmentTarget = { owner: string; id: string };
export type UploadRow = {
  id: string;
  name: string;
  kind: 'reading' | 'uploading' | 'failed' | 'unknown';
  error?: UiText;
  original?: any;
};
export type AttachmentEdit = { attachments: DraftAttachment[]; settledUploads: string[] };
type UploadSubscription = { next(): Promise<any[] | null>; close(): void };
type UploadIntake = { next(): Promise<unknown>; close(): void };

// Native status is only progress. The original Journal receipt is the sole
// authority for readiness, recovery and whether an attempt exists at all.
function attachmentStatus(value: unknown): AttachmentStatus | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.operationId !== 'string' ||
    typeof data.name !== 'string' ||
    !['reading', 'uploading', 'failed', 'complete'].includes(String(data.kind)) ||
    (data.error !== undefined && typeof data.error !== 'string')
  )
    return null;
  return data as AttachmentStatus;
}

export function createAttachmentDraft(options: {
  sessionId: string;
  client: ScopedHost;
  changed(): void;
  focus(): void;
}) {
  const files = signal<DraftAttachment[]>([]);
  const originals = signal<any[]>([]);
  const selecting = signal<UploadRow[]>([]);
  const picker = signal(false);
  const restoring = signal(true);
  const error = createText();
  const notice = createText();
  const recovering = signal<string | null>(null);
  // Keep adopted IDs for this observer's lifetime: a Journal read that began
  // before CAS must not resurrect a file after removal or a successful send.
  const settled = new Map<string, 'pending' | 'saved'>();
  let alive = true;
  let subscription: UploadSubscription | null = null;
  const intakes = signal<Set<UploadIntake>>(new Set());
  let reading = false;
  let watchFailed = false;
  const owns = (target: { owner: string }) => alive && target.owner === options.sessionId;
  const returned = (original: any) =>
    original.receipt?.kind === 'recorded' && original.receipt.outcome?.kind === 'returned'
      ? original.receipt.outcome.value
      : null;
  const uploaded = (original: any): DraftAttachment | null => {
    const value = returned(original),
      attachment = value?.attachment;
    if (
      value?.kind !== 'uploaded' ||
      attachment?.sessionId !== options.sessionId ||
      typeof attachment.id !== 'string' ||
      typeof attachment.name !== 'string' ||
      typeof attachment.mimeType !== 'string' ||
      !Number.isSafeInteger(attachment.bytes) ||
      attachment.bytes < 0
    )
      return null;
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
    };
  };
  const receive = (operations: any[]) => {
    if (!alive) return;
    let changed = false;
    for (const original of operations) {
      const attachment = uploaded(original);
      if (!attachment || settled.has(original.id)) continue;
      if (!files().some((file) => file.id === attachment.id)) files.set([...files(), attachment]);
      settled.set(original.id, 'pending');
      changed = true;
    }
    if (changed) options.changed();
    originals.set(operations);
    selecting.set(
      selecting().filter((item) => {
        const original = operations.find((original) => original.id === item.id);
        // Reserve/prepared invalidations arrive while this native worker still
        // owns the upload. Its known progress is not an unknown outcome.
        return (
          !original ||
          ((item.kind === 'reading' || item.kind === 'uploading') &&
            !original.receipt &&
            !original.abandoned)
        );
      }),
    );
    restoring.set(false);
  };
  const receiveOne = (original: any) => {
    const known = originals().find((item) => item.id === original.id);
    // A slower exact lookup must not replace an already recorded receipt.
    receive([
      ...originals().filter((item) => item.id !== original.id),
      known?.receipt && !original.receipt ? known : original,
    ]);
  };
  const rows = (): UploadRow[] => [
    ...selecting(),
    ...originals()
      .filter(
        (original) =>
          !settled.has(original.id) &&
          !uploaded(original) &&
          !selecting().some((item) => item.id === original.id),
      )
      .map((original) => {
        const result = returned(original);
        return {
          id: original.id,
          name: original.upload.name,
          kind:
            result?.kind === 'rejected' || original.abandoned
              ? ('failed' as const)
              : ('unknown' as const),
          error:
            result?.kind === 'rejected'
              ? uiMessage('Upload rejected: {reason}', { reason: result.reason })
              : undefined,
          original,
        };
      }),
  ];
  const start = async () => {
    if (!alive || reading) return;
    reading = true;
    watchFailed = false;
    error.set('');
    let stream: UploadSubscription | null = null;
    try {
      // Native registers this observer before the first Journal read.
      stream = watchUploads(options.client);
      subscription = stream;
      while (alive && subscription === stream) {
        const operations = await stream!.next();
        if (!alive || subscription !== stream) return;
        if (operations === null) throw new UiError('Attachment updates ended.');
        receive(operations);
      }
    } catch (reason) {
      if (alive) {
        watchFailed = true;
        error.set(errorText(reason));
      }
    } finally {
      stream?.close();
      if (subscription === stream) subscription = null;
      reading = false;
    }
  };
  cleanup(() => {
    alive = false;
    subscription?.close();
    subscription = null;
    const observing = intakes();
    intakes.set(new Set());
    for (const intake of observing) intake.close();
  });
  const inspect = async (target: AttachmentTarget) => {
    if (!owns(target) || recovering()) return;
    recovering.set(target.id);
    if (!watchFailed) error.set('');
    try {
      const original = await findUpload(options.client, target.id);
      if (!alive) return;
      if (original !== null) {
        receiveOne(original);
        return;
      }
      // None is an exact original-UUID lookup, never absence from a bounded list.
      selecting.set(
        selecting().map((item) => (item.id === target.id ? { ...item, kind: 'failed' } : item)),
      );
    } catch (reason) {
      if (alive)
        selecting.set(
          selecting().map((item) =>
            item.id === target.id ? { ...item, kind: 'unknown', error: errorText(reason) } : item,
          ),
        );
    } finally {
      if (alive) recovering.set(null);
    }
  };
  const status = (value: unknown, focus = true) => {
    const update = attachmentStatus(value);
    if (!alive || !update || settled.has(update.operationId)) return;
    const original = originals().find((original) => original.id === update.operationId);
    if (original && (original.receipt || original.abandoned)) return;
    if (update.kind === 'reading') {
      notice.set('');
      picker.set(false);
      if (focus) options.focus();
    }
    const kept = selecting().filter((item) => item.id !== update.operationId);
    selecting.set([
      ...kept,
      {
        id: update.operationId,
        name: update.name,
        kind: update.kind === 'failed' || update.kind === 'complete' ? 'unknown' : update.kind,
        error: update.error,
      },
    ]);
    if (update.kind === 'failed' || update.kind === 'complete')
      void inspect({ owner: options.sessionId, id: update.operationId });
  };
  const remove = (target: AttachmentTarget) => {
    if (!owns(target)) return;
    const original = originals().find((item) => item.id === target.id);
    const local = selecting().find((item) => item.id === target.id);
    if (
      (original && !returned(original) && !original.abandoned) ||
      (local && local.kind !== 'failed')
    )
      return;
    if (original && !settled.has(original.id)) settled.set(original.id, 'pending');
    selecting.set(selecting().filter((item) => item.id !== target.id));
    files.set(files().filter((file) => file.id !== target.id));
    if (!watchFailed) error.set('');
    options.changed();
  };
  const recover = async (target: AttachmentTarget) => {
    if (!owns(target) || recovering()) return;
    recovering.set(target.id);
    if (!watchFailed) error.set('');
    try {
      const original = await recoverUpload(options.client, target.id);
      if (alive) receiveOne(original);
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    } finally {
      if (alive) recovering.set(null);
    }
  };
  const abandon = async (target: AttachmentTarget) => {
    if (!owns(target) || recovering()) return;
    recovering.set(target.id);
    if (!watchFailed) error.set('');
    try {
      const original = await abandonUpload(options.client, target.id);
      if (!alive) return;
      if (!original.abandoned)
        throw new UiError('This upload is prepared. Recover its original receipt.');
      receiveOne(original);
      settled.set(original.id, 'pending');
      options.changed();
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    } finally {
      if (alive) recovering.set(null);
    }
  };
  return {
    sessionId: options.sessionId,
    client: options.client,
    files,
    rows,
    picker,
    restoring,
    error,
    notice,
    recovering,
    status,
    reportError(reason: unknown) {
      if (alive) error.set(errorText(reason));
    },
    notify(reason: unknown) {
      if (alive) notice.set(errorText(reason));
    },
    clearNotice() {
      if (alive) notice.set('');
    },
    observeIntake(intake: UploadIntake, onText: (text: string) => void) {
      if (!alive) {
        intake.close();
        return;
      }
      if (!watchFailed) error.set('');
      notice.set('');
      intakes.set(new Set([...intakes(), intake]));
      void (async () => {
        try {
          while (alive && intakes().has(intake)) {
            const value = await intake.next();
            if (!alive || !intakes().has(intake) || value === null) break;
            if (
              value &&
              typeof value === 'object' &&
              'kind' in value &&
              value.kind === 'text' &&
              'text' in value &&
              typeof value.text === 'string'
            )
              onText(value.text);
            else if (
              value &&
              typeof value === 'object' &&
              'kind' in value &&
              value.kind === 'notice' &&
              'error' in value &&
              typeof value.error === 'string'
            )
              notice.set(errorText(value.error));
            else status(value, false);
          }
        } catch (reason) {
          if (alive) notice.set(errorText(reason));
        } finally {
          const observing = new Set(intakes());
          if (observing.delete(intake)) intakes.set(observing);
          intake.close();
        }
      })();
    },
    remove,
    recover,
    abandon,
    inspect,
    open(target: { owner: string; value: boolean }) {
      if (!owns(target)) return;
      picker.set(target.value);
      if (!target.value) options.focus();
    },
    restore(attachments: DraftAttachment[]) {
      if (alive) files.set(attachments);
    },
    start,
    retry: start,
    snapshot: (): AttachmentEdit => ({
      attachments: [...files()],
      settledUploads: [...settled].filter(([, state]) => state === 'pending').map(([id]) => id),
    }),
    saved(snapshot: AttachmentEdit) {
      for (const id of snapshot.settledUploads) settled.set(id, 'saved');
    },
    ids: () => files().map((file) => file.id),
    same(ids: string[]) {
      return ids.length === files().length && ids.every((id, index) => files()[index].id === id);
    },
    sent(ids: string[]) {
      const sent = new Set(ids),
        remaining = files().filter((file) => !sent.has(file.id));
      if (remaining.length !== files().length) {
        files.set(remaining);
        options.changed();
      }
    },
    blocked() {
      if (restoring()) return tr('Restoring attachment drafts…');
      if (error()) return tr('Attachment state needs attention. Your draft is kept.');
      if (intakes().size) return tr('Preparing attachments… You can keep typing.');
      if (rows().some((row) => row.kind === 'unknown'))
        return tr('Recover the original upload receipt before sending.');
      if (rows().some((row) => row.kind === 'reading' || row.kind === 'uploading'))
        return tr('Uploading attachments… Your typing is kept.');
      if (rows().length) return tr('Remove the failed attachment or choose it again.');
      return '';
    },
  };
}
export type AttachmentDraft = ReturnType<typeof createAttachmentDraft>;
