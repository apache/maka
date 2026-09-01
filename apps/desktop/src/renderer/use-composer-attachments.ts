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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ATTACHMENT_MIME_SNIFF_BYTES,
  attachmentKindFromMimeType,
  guessMimeFromName,
  resolveAttachmentMimeType,
} from '@maka/core/attachments';
import {
  DIRECTORY_REFERENCE_MAX_COUNT,
  type AttachmentRef,
  type DirectoryReference,
} from '@maka/core/events';
import { useUiLocale } from '@maka/ui';
import {
  pendingAttachmentSourceKey,
  type PendingAttachment,
} from './composer-attachments.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  appendPending,
  removePending,
  removePendingItems,
  selectPending,
  type PendingByKey,
} from './pending-items.js';

export interface ComposerAttachmentService {
  pickFiles(): Promise<
    | {
        ok: true;
        files: Array<{
          approvalId: string;
          name: string;
          mimeType?: string;
          size: number;
        }>;
      }
    | { ok: false; reason: 'cancelled' }
  >;
  previewApproval(approvalId: string): Promise<
    | { ok: true; base64: string; mimeType: string }
    | { ok: false; reason: string }
  >;
  pickDirectory?(): Promise<
    | { ok: true; reference: DirectoryReference }
    | { ok: false; reason: 'cancelled' }
  >;
}

type ToastApi = {
  error(title: string, description?: string): void;
};

type ComposerPendingState = {
  attachments: PendingByKey<PendingAttachment>;
  directories: Record<string, readonly DirectoryReference[]>;
};

class ComposerAttachmentLifecycle {
  stagedKeys = new Set<string>();
  readonly #shownOwners = new Set<string>();

  claimImageNotice(ownerKey: string): boolean {
    if (this.#shownOwners.has(ownerKey)) return false;
    this.#shownOwners.add(ownerKey);
    return true;
  }

  reset(ownerKey: string): void {
    this.#shownOwners.delete(ownerKey);
  }

  transfer(sourceOwnerKey: string, targetOwnerKey: string): void {
    if (!this.#shownOwners.delete(sourceOwnerKey)) return;
    this.#shownOwners.add(targetOwnerKey);
  }
}

function approvalToPending(file: {
  approvalId: string;
  name: string;
  mimeType?: string;
  size: number;
}): PendingAttachment {
  const mimeType = file.mimeType ?? guessMimeFromName(file.name);
  return {
    stagingKey: crypto.randomUUID(),
    displayName: file.name,
    mimeType,
    kind: attachmentKindFromMimeType(mimeType, file.name),
    size: file.size,
    source: { type: 'approval', approvalId: file.approvalId, name: file.name },
  };
}

async function fileToPending(file: File): Promise<PendingAttachment> {
  // Sniff the leading bytes so a spoofed extension (a real image named
  // `report.pdf`, or a PDF named `photo.png`) stages under its true kind —
  // matching how main resolves picked files and how the send path routes.
  const mimeType = await sniffFileMimeType(file);
  return {
    stagingKey: crypto.randomUUID(),
    displayName: file.name,
    mimeType,
    kind: attachmentKindFromMimeType(mimeType, file.name),
    size: file.size,
    source: { type: 'file', file },
  };
}

/** Content type for a dropped/pasted blob, from its {@link ATTACHMENT_MIME_SNIFF_BYTES}
 * prefix. A failed slice read resolves an empty prefix through the same policy
 * rather than falling back to the renderer-declared type — reinstating that
 * unverified image/PDF claim is exactly what this content-first path avoids. */
async function sniffFileMimeType(file: File): Promise<string> {
  const declared = file.type || undefined;
  let prefix = new Uint8Array();
  try {
    prefix = new Uint8Array(await file.slice(0, ATTACHMENT_MIME_SNIFF_BYTES).arrayBuffer());
  } catch {
    // Fall through with the empty prefix so the declared image/PDF claim is
    // downgraded, not trusted; staging stays unblocked and the send path re-reads.
  }
  return resolveAttachmentMimeType(prefix, declared, file.name);
}

function retainedToPending(attachment: AttachmentRef): PendingAttachment {
  return {
    stagingKey: crypto.randomUUID(),
    displayName: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.bytes,
    source: { type: 'retained', attachment: structuredClone(attachment) },
  };
}

/** True once the URL has decoded as an image in this renderer. Gates every
 * preview before it reaches the drawer, so a corrupt file or a spoofed
 * extension falls back to the named file card instead of Astryx Thumbnail's
 * anonymous placeholder. */
async function probeImageUrl(url: string): Promise<boolean> {
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return true;
  } catch {
    return false;
  }
}

function releasePreviewUrl(url: string | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

export function useComposerAttachments(options: {
  draftKey: string;
  directoryHostId?: string;
  toastApi: ToastApi;
  service: ComposerAttachmentService;
  imageNotice?:
    | {
        /** Undefined means there is no selected target yet. */
        supportsVision(): boolean | undefined;
        notify(title: string, description?: string): void;
      }
    | undefined;
}) {
  const uiLocale = useUiLocale();
  const copy = getDesktopConversationCopy(uiLocale).actions;
  const [pendingState, setPendingState] = useState<ComposerPendingState>({
    attachments: {},
    directories: {},
  });
  const pendingByKey = pendingState.attachments;
  const directoriesByKey = pendingState.directories;
  // Preview URLs by stagingKey, kept beside — not inside — the staged items
  // so a late-arriving preview never replaces an item object out from under
  // an in-flight send. Entries only exist for staged items (see the cleanup
  // effect); values are object URLs (file source) or data URLs (approval).
  const [previewByStagingKey, setPreviewByStagingKey] = useState<Record<string, string>>({});
  // Live mirror of every staged item's key, for async preview arrivals to
  // check before writing: state snapshots inside a .then are stale by design.
  const lifecycleRef = useRef(new ComposerAttachmentLifecycle());
  function updateAttachments(
    update: (current: PendingByKey<PendingAttachment>) => PendingByKey<PendingAttachment>,
  ): void {
    setPendingState((current) => ({ ...current, attachments: update(current.attachments) }));
  }
  function updateDirectories(
    update: (
      current: Record<string, readonly DirectoryReference[]>,
    ) => Record<string, readonly DirectoryReference[]>,
  ): void {
    setPendingState((current) => ({ ...current, directories: update(current.directories) }));
  }
  const liveOptionsRef = useRef({
    draftKey: options.draftKey,
    imageNotice: options.imageNotice,
    copy,
    directoryOwner: options,
  });
  liveOptionsRef.current.directoryOwner = options;
  useEffect(() => {
    liveOptionsRef.current = {
      ...liveOptionsRef.current,
      draftKey: options.draftKey,
      imageNotice: options.imageNotice,
      copy,
    };
  }, [copy, options.draftKey, options.imageNotice]);
  const stagedAttachments = selectPending(pendingByKey, options.draftKey);
  const directoryDraftKey = `${options.draftKey}:${options.directoryHostId ?? 'unresolved'}`;
  const pendingDirectories = directoriesByKey[directoryDraftKey] ?? [];
  const pendingAttachments = useMemo(
    () =>
      stagedAttachments.map((item) => {
        const previewUrl = previewByStagingKey[item.stagingKey];
        return previewUrl ? { ...item, previewUrl } : item;
      }),
    [stagedAttachments, previewByStagingKey],
  );

  // Single owner of preview lifecycle: whenever the staged set changes,
  // refresh the live-key mirror and drop (+ revoke) every preview whose item
  // is gone — covering remove, submit, and any preview that raced past the
  // write guard below.
  useEffect(() => {
    const liveKeys = new Set<string>();
    for (const items of Object.values(pendingByKey)) {
      for (const item of items) liveKeys.add(item.stagingKey);
    }
    lifecycleRef.current.stagedKeys = liveKeys;
    setPreviewByStagingKey((current) => {
      const deadKeys = Object.keys(current).filter((key) => !liveKeys.has(key));
      if (deadKeys.length === 0) return current;
      const next = { ...current };
      for (const key of deadKeys) {
        releasePreviewUrl(next[key]);
        delete next[key];
      }
      return next;
    });
  }, [pendingByKey]);

  function commitPreview(stagingKey: string, url: string): void {
    if (!lifecycleRef.current.stagedKeys.has(stagingKey)) {
      // The item was removed or sent while the preview was in flight.
      releasePreviewUrl(url);
      return;
    }
    setPreviewByStagingKey((current) => ({ ...current, [stagingKey]: url }));
  }

  function notifyStagedImages(
    ownerKey: string,
    staged: readonly PendingAttachment[],
  ): void {
    if (!staged.some((attachment) => attachment.kind === 'image')) return;
    const { copy: liveCopy, imageNotice: notice } = liveOptionsRef.current;
    if (!notice) return;
    if (notice.supportsVision() !== false) return;
    if (!lifecycleRef.current.claimImageNotice(ownerKey)) return;
    notice.notify(
      liveCopy.imageAttachmentNotDirectTitle,
      liveCopy.imageAttachmentNotDirectDescription,
    );
  }

  /** SEQUENTIAL by design: each approval preview makes main read and decode
   * the full original (bounded by the file's own stat size), so firing a
   * whole picker batch concurrently multiplies peak memory by the batch
   * size. One at a time keeps the ceiling at a single image; the drawer
   * shows named file cards until each thumbnail lands. */
  async function loadPreviewsSequentially(staged: readonly PendingAttachment[]): Promise<void> {
    for (const item of staged) {
      if (item.kind !== 'image') continue;
      if (!lifecycleRef.current.stagedKeys.has(item.stagingKey)) continue;
      try {
        if (item.source.type === 'file') {
          const url = URL.createObjectURL(item.source.file);
          if (await probeImageUrl(url)) commitPreview(item.stagingKey, url);
          else releasePreviewUrl(url);
          continue;
        }
        if (item.source.type === 'retained') continue;
        const preview = await options.service.previewApproval(item.source.approvalId);
        if (!preview.ok) continue;
        const url = `data:${preview.mimeType};base64,${preview.base64}`;
        if (await probeImageUrl(url)) commitPreview(item.stagingKey, url);
      } catch {
        // Soft by design: a failed preview leaves the named file card.
      }
    }
  }

  async function pickAttachments(): Promise<void> {
    try {
      const result = await options.service.pickFiles();
      if (!result.ok) return;
      // Resolved after the dialog closes, never captured before it opens: the
      // surface can change while a native dialog is up, and files the user just
      // chose belong in the composer they are looking at — not in a bucket they
      // have since left, where the files would be invisible but still sendable.
      const ownerKey = liveOptionsRef.current.draftKey;
      const staged = result.files.map(approvalToPending);
      updateAttachments((map) => appendPending(map, ownerKey, staged));
      for (const item of staged) lifecycleRef.current.stagedKeys.add(item.stagingKey);
      notifyStagedImages(ownerKey, staged);
      void loadPreviewsSequentially(staged);
    } catch (error) {
      options.toastApi.error(
        copy.attachmentFailedTitle,
        localizedShellErrorMessage(error, copy.tryAgain, uiLocale),
      );
    }
  }

  async function pickDirectory(): Promise<void> {
    const owner = liveOptionsRef.current.directoryOwner;
    if (!owner.directoryHostId || !owner.service.pickDirectory) return;
    const ownerKey = `${owner.draftKey}:${owner.directoryHostId}`;
    try {
      const result = await owner.service.pickDirectory();
      if (!result.ok) return;
      const current = liveOptionsRef.current.directoryOwner;
      if (
        current.draftKey !== owner.draftKey
        || current.directoryHostId !== owner.directoryHostId
      ) return;
      if (result.reference.hostId !== owner.directoryHostId) {
        throw new Error('Directory references require the local Host.');
      }
      updateDirectories((all) => {
        const previous = all[ownerKey] ?? [];
        if (
          previous.length >= DIRECTORY_REFERENCE_MAX_COUNT
          || previous.some((entry) =>
            entry.path === result.reference.path && entry.hostId === result.reference.hostId
          )
        ) return all;
        return { ...all, [ownerKey]: [...previous, result.reference] };
      });
    } catch (error) {
      owner.toastApi.error(
        copy.attachmentFailedTitle,
        localizedShellErrorMessage(error, copy.tryAgain, uiLocale),
      );
    }
  }

  async function attachFilePaths(files: File[]): Promise<void> {
    if (files.length === 0) return;
    // Bind the owner AFTER the sniff reads resolve, never before: fileToPending
    // became async to read each file's leading bytes, so the surface can change
    // during that I/O (a network volume or spun-down drive makes it seconds).
    // The files belong in the composer the user is looking at now — not a bucket
    // they have since left, where they would be invisible but still sendable.
    // Same reasoning as pickAttachments above.
    const staged = await Promise.all(files.map(fileToPending));
    const ownerKey = liveOptionsRef.current.draftKey;
    updateAttachments((map) => appendPending(map, ownerKey, staged));
    for (const item of staged) lifecycleRef.current.stagedKeys.add(item.stagingKey);
    notifyStagedImages(ownerKey, staged);
    void loadPreviewsSequentially(staged);
  }

  function restoreAttachments(ownerKey: string, attachments: readonly AttachmentRef[]): void {
    if (attachments.length === 0) return;
    const staged = attachments.map(retainedToPending);
    updateAttachments((map) => appendPending(map, ownerKey, staged));
    for (const item of staged) lifecycleRef.current.stagedKeys.add(item.stagingKey);
  }

  function removeAttachment(index: number): void {
    const ownerKey = options.draftKey;
    updateAttachments((map) => removePending(map, ownerKey, index));
  }

  function removeDirectory(index: number): void {
    updateDirectories((all) => {
      const previous = all[directoryDraftKey] ?? [];
      if (index < 0 || index >= previous.length) return all;
      return {
        ...all,
        [directoryDraftKey]: previous.filter((_, entryIndex) => entryIndex !== index),
      };
    });
  }

  function clearSubmittedContext(submitted?: readonly PendingAttachment[]): void {
    setPendingState((current) => {
      const attachments = submitted
        ? removePendingItems(
            current.attachments,
            options.draftKey,
            submitted,
            pendingAttachmentSourceKey,
          )
        : current.attachments;
      const previous = current.directories[directoryDraftKey] ?? [];
      const next = previous.filter((reference) => !pendingDirectories.includes(reference));
      return {
        attachments,
        directories: next.length === previous.length
          ? current.directories
          : { ...current.directories, [directoryDraftKey]: next },
      };
    });
  }

  function clearSubmittedAttachments(submitted: readonly PendingAttachment[]): void {
    updateAttachments((current) =>
      removePendingItems(current, options.draftKey, submitted, pendingAttachmentSourceKey),
    );
  }

  function clearAllAttachments(): void {
    updateAttachments(() => ({}));
  }

  return {
    pendingAttachments,
    pendingDirectories,
    submittableAttachments: pendingAttachments.length ? pendingAttachments : undefined,
    hasPendingContext: pendingAttachments.length > 0 || pendingDirectories.length > 0,
    directoryOptions: pendingDirectories.length > 0
      ? { directoryReferences: pendingDirectories }
      : {},
    directoryComposerProps: {
      pendingDirectories,
      onRemoveDirectory: removeDirectory,
      onPickDirectory: pendingDirectories.length < DIRECTORY_REFERENCE_MAX_COUNT
        ? pickDirectory
        : undefined,
    },
    pickAttachments,
    attachFilePaths,
    restoreAttachments,
    removeAttachment,
    clearSubmittedContext,
    clearSubmittedAttachments,
    clearAllAttachments,
    imageNoticeLifecycle: lifecycleRef.current,
  };
}
