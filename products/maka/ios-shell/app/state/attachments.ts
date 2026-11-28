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

import {
  cleanup,
  effect,
  host,
  LayoutAnimation,
  Picker,
  reduceMotion,
  signal,
  untracked,
  type Accessor,
} from 'nsh';
import { iosAttachments } from 'maka/host';
import type {
  AgentAttachment,
  AgentAttachmentUploadResult,
} from '../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../locale';
import { motion } from '../theme/tokens';
import { showToast } from './hostPool';

export const attachmentLimit = 4;
const maxBytes = 16 * 1024 * 1024;
export type AttachmentInfo = Pick<AgentAttachment, 'name' | 'mimeType' | 'bytes'>;
export type ReadyAttachment = AttachmentInfo & { id: string };
export type PickerKind = 'photos' | 'files';
type Local = { url: string; picker: PickerKind };
type Entry = { key: number; info: AttachmentInfo; local?: Local };
export type DraftAttachment = Entry &
  (
    | { kind: 'uploading'; attempt: string; phase: 'waiting' | 'uploading' | 'confirming' }
    | { kind: 'ready'; info: ReadyAttachment }
    | {
        kind: 'failed';
        reason: 'not_submitted' | 'unconfirmed' | 'invalid_file' | 'closed' | 'archived';
        action: 'retry' | 'pick' | 'remove';
        picker: PickerKind;
      }
  );

export type UploadResult =
  | AgentAttachmentUploadResult
  | { kind: 'cancelled' | 'not_submitted' | 'unconfirmed' | 'too_large' };

export function conversationKey(rootId: string, sessionId: string): string {
  return rootId + '::' + sessionId;
}

const empty: readonly DraftAttachment[] = [];
const drafts = signal<ReadonlyMap<string, readonly DraftAttachment[]>>(new Map());
let nextKey = 0;
const owners = new Map<string, string>();

export const draftAttachments = (key: string) => drafts().get(key) ?? empty;

function update(
  key: string,
  change: (items: readonly DraftAttachment[]) => readonly DraftAttachment[],
) {
  drafts.update((current) => {
    const items = current.get(key) ?? empty;
    const next = change(items);
    if (next === items) return current;
    const following = new Map(current);
    if (next.length) following.set(key, next);
    else following.delete(key);
    return following;
  });
}

function animateAttachmentChange() {
  if (reduceMotion()) return;
  const fade = { type: 'easeInEaseOut', property: 'opacity' } as const;
  LayoutAnimation.configureNext({ duration: motion.fast, create: fade, delete: fade });
}

function release(item: DraftAttachment) {
  if (item.local) URL.revokeObjectURL(item.local.url);
  if (item.kind === 'uploading') iosAttachments.cancel(item.attempt);
}

function remove(owner: string, key: number) {
  animateAttachmentChange();
  update(owner, (items) =>
    items.filter((item) => {
      if (item.key !== key) return true;
      release(item);
      return false;
    }),
  );
}

export function takeAttachmentSnapshot(owner: string): readonly ReadyAttachment[] | null {
  const items = draftAttachments(owner);
  return items.every((item) => item.kind === 'ready') ? items.map((item) => item.info) : null;
}

export function consumeAttachments(owner: string, snapshot: readonly ReadyAttachment[]) {
  if (!snapshot.length) return;
  update(owner, (items) =>
    items.filter((item) => {
      if (item.kind !== 'ready' || !snapshot.includes(item.info)) return true;
      release(item);
      return false;
    }),
  );
}

export function mergeAttachments(owner: string, snapshot: readonly ReadyAttachment[]) {
  const items = draftAttachments(owner);
  const additional = snapshot.filter(
    ({ id }) => !items.some((item) => item.kind === 'ready' && item.info.id === id),
  );
  if (items.length + additional.length > attachmentLimit) {
    showToast(tr('Attachment limit reached ({count})', { count: attachmentLimit }));
    return false;
  }
  if (additional.length) {
    update(owner, (items) => [
      ...items,
      ...additional.map((info) => ({ kind: 'ready' as const, key: ++nextKey, info })),
    ]);
  }
  return true;
}

function patchAttempt(
  attempt: string,
  change: (item: Extract<DraftAttachment, { kind: 'uploading' }>) => DraftAttachment | null,
) {
  const owner = owners.get(attempt);
  if (!owner) return;
  update(owner, (items) => {
    const index = items.findIndex((item) => item.kind === 'uploading' && item.attempt === attempt);
    const item = items[index];
    if (item?.kind !== 'uploading') return items;
    const next = change(item);
    const list = items.slice();
    if (next) list[index] = next;
    else list.splice(index, 1);
    return list;
  });
}

host.on('ios.attachmentProgress', (data) => {
  const { attemptId, phase } = data as { attemptId: string; phase: 'uploading' | 'confirming' };
  patchAttempt(attemptId, (item) => ({ ...item, phase }));
});

async function upload(
  owner: string,
  rootId: string,
  sessionId: string,
  generation: number,
  item: Extract<DraftAttachment, { kind: 'uploading' }> & { local: Local },
) {
  const { attempt, local } = item;
  owners.set(attempt, owner);
  let result: UploadResult;
  try {
    result = await iosAttachments.upload(
      rootId,
      generation,
      sessionId,
      attempt,
      item.info.name,
      local.url,
    );
  } catch (cause) {
    console.warn('Could not start attachment upload', cause);
    result = { kind: 'unconfirmed' };
  }
  patchAttempt(attempt, (current) => {
    const { key, info, local: preview } = current;
    if (result.kind === 'uploaded') {
      const { sessionId: target, ...record } = result.attachment;
      if (target === sessionId) {
        const keep = record.mimeType.startsWith('image/') ? preview : undefined;
        if (!keep && preview) URL.revokeObjectURL(preview.url);
        return { key, info: record, local: keep, kind: 'ready' };
      }
      console.warn('Host returned an attachment for a different session', target);
      result = { kind: 'unconfirmed' };
    }
    if (result.kind === 'too_large') {
      if (preview) URL.revokeObjectURL(preview.url);
      showToast(tr('{name} exceeds 16 MiB', { name: info.name }));
      return null;
    }
    const reason =
      result.kind === 'rejected'
        ? result.reason
        : result.kind === 'cancelled'
          ? 'not_submitted'
          : result.kind;
    const action =
      reason === 'not_submitted'
        ? preview
          ? 'retry'
          : 'pick'
        : reason === 'invalid_file'
          ? 'pick'
          : 'remove';
    if (action !== 'retry' && preview) URL.revokeObjectURL(preview.url);
    return {
      key,
      info,
      kind: 'failed',
      reason,
      action,
      picker: local.picker,
      local: action === 'retry' ? preview : undefined,
    };
  });
  owners.delete(attempt);
}

export function createAttachmentComposer(
  rootId: string,
  sessionId: string,
  active: Accessor<boolean>,
  generation: Accessor<number | undefined>,
) {
  const owner = conversationKey(rootId, sessionId);
  const picking = signal(false);
  let lease: object | undefined;
  effect(() => {
    if (!active() || generation() === undefined) return;
    lease = {};
    cleanup(() => {
      lease = undefined;
      untracked(() =>
        update(owner, (items) =>
          items.map((item) => {
            if (item.kind === 'uploading') iosAttachments.cancelBeforeConfirm(item.attempt);
            if (item.local) URL.revokeObjectURL(item.local.url);
            if (item.kind === 'failed' && item.action === 'retry') {
              return { ...item, action: 'pick', local: undefined };
            }
            return item.local ? { ...item, local: undefined } : item;
          }),
        ),
      );
    });
  });
  const items = () => draftAttachments(owner);
  const begin = (entry: Entry & { local: Local }, bound: number, replace?: number) => {
    const item = {
      ...entry,
      kind: 'uploading' as const,
      attempt: crypto.randomUUID(),
      phase: 'waiting' as const,
    };
    update(owner, (items) => {
      if (replace === undefined) return [...items, item];
      return items.map((previous) => (previous.key === replace ? item : previous));
    });
    void upload(owner, rootId, sessionId, bound, item);
  };
  const pick = async (picker: PickerKind, replace?: number) => {
    const bound = generation();
    const pickingLease = lease;
    if (bound === undefined || !active() || !pickingLease || picking()) return;
    const slots = () =>
      attachmentLimit -
      items().length +
      Number(replace !== undefined && items().some(({ key }) => key === replace));
    const limit = replace === undefined ? slots() : Math.min(1, slots());
    if (limit <= 0) return;
    picking.set(true);
    try {
      const options = { multiple: limit > 1, limit };
      const selected =
        picker === 'photos'
          ? await Picker.pickImages({ ...options, maxDimension: 2048, format: 'compatible' })
          : await Picker.pickFiles({ ...options, maxSize: maxBytes });
      if (!active() || lease !== pickingLease || generation() !== bound) return;
      if (replace !== undefined && !items().some(({ key }) => key === replace)) return;
      const rejected: string[] = [];
      let remaining = replace === undefined ? slots() : 1;
      let animating = false;
      for (const picked of selected) {
        const file = picked.file;
        const name = file?.name ?? ('name' in picked ? picked.name : '');
        if (!file || file.size > maxBytes) {
          rejected.push(tr('{name} exceeds 16 MiB', { name }));
          continue;
        }
        if (remaining <= 0) continue;
        remaining--;
        if (!animating) {
          animateAttachmentChange();
          animating = true;
        }
        begin(
          {
            key: replace ?? ++nextKey,
            info: { name, mimeType: file.type, bytes: file.size },
            local: { picker, url: URL.createObjectURL(file) },
          },
          bound,
          replace,
        );
      }
      if (rejected.length) showToast(rejected.join('\n'));
    } catch (cause) {
      console.warn('Could not select attachments', cause);
      if (lease === pickingLease) showToast(tr('Could not select attachments.'));
    } finally {
      picking.set(false);
    }
  };
  return {
    items,
    canPick: () => generation() !== undefined && !picking() && items().length < attachmentLimit,
    pick,
    remove: (key: number) => remove(owner, key),
    recover: (key: number) => {
      const item = items().find((item) => item.key === key);
      if (item?.kind !== 'failed') return;
      if (item.action === 'pick') void pick(item.picker, key);
      if (item.action === 'retry') {
        const bound = generation();
        if (bound !== undefined && active() && item.local) {
          begin({ key, info: item.info, local: item.local }, bound, key);
        }
      }
    },
  };
}

export type AttachmentComposer = ReturnType<typeof createAttachmentComposer>;
