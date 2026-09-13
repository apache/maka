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

import type { AttachmentRef, QuoteRef } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { PendingAttachment } from './composer-attachments.js';

/**
 * Snapshot of the composer's staged context, read fresh at every use: the
 * staging hooks bind their mutators to the active session's draft key, which
 * moves across the revision commit (source → branch child).
 */
export type RevisionStagedContext = {
  quotes: readonly QuoteRef[];
  attachments: readonly PendingAttachment[];
  restoreQuotes(ownerKey: string, quotes: readonly QuoteRef[]): void;
  restoreAttachments(ownerKey: string, attachments: readonly AttachmentRef[]): void;
  removeQuote(index: number): void;
  removeAttachment(index: number): void;
};

/** The edit-and-resend source context a staged plate must match verbatim. */
export type RevisionStagedSource = {
  originalQuotes: readonly QuoteRef[];
  originalAttachments: readonly AttachmentRef[];
};

/**
 * Surface-neutral revision draft: the shared staged-context fields every
 * edit-and-resend client carries, parameterized by its copy-attempt phase.
 */
export type TurnRevisionDraftBase<Phase> = {
  sourceSessionId: string;
  sourceTurnId: string;
  copyId: string;
  copyPhase: Phase;
  /** Active owner of the draft. Changes to the branch child after prepare. */
  draftSessionId: string;
  originalText: string;
  previousComposerText: string;
  originalQuotes: readonly QuoteRef[];
  originalAttachments: readonly AttachmentRef[];
};


function quoteKey(quote: QuoteRef): string {
  return JSON.stringify([quote.text, quote.label ?? null, quote.sourceTurnId ?? null]);
}

function attachmentToPending(attachment: AttachmentRef): PendingAttachment {
  return {
    stagingKey: `revision:${JSON.stringify(attachment)}`,
    displayName: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.bytes,
    source: { type: 'retained', attachment },
  };
}

function attachmentKey(attachment: PendingAttachment): string {
  return JSON.stringify(
    attachment.source.type === 'retained' ? attachment.source.attachment : attachment.source,
  );
}

/**
 * A send whose text and staged context both match what the edit staged is a
 * no-op retry: the replacement would duplicate the source turn verbatim.
 * Compared in plate order — the restaged source context is the whole plate,
 * because editing is refused while the user has own context staged.
 */
export function revisionStagedContextUnchanged(
  source: RevisionStagedSource,
  originalText: string,
  text: string,
  stagedQuotes: readonly QuoteRef[],
  stagedAttachments: readonly PendingAttachment[],
): boolean {
  if (text.trim() !== originalText.trim()) return false;
  if (stagedQuotes.map(quoteKey).join('\n') !== source.originalQuotes.map(quoteKey).join('\n')) {
    return false;
  }
  return (
    stagedAttachments.map(attachmentKey).join('\n') ===
    source.originalAttachments.map(attachmentToPending).map(attachmentKey).join('\n')
  );
}

/**
 * True when the plates hold anything beyond the edit's own restage — user
 * additions cannot silently mix into the replacement submit. Pending
 * directories have no snapshot here; the caller refuses through its own
 * pending-context check.
 */
export function revisionStagedContextHasAdditions(
  source: RevisionStagedSource,
  stagedQuotes: readonly QuoteRef[],
  stagedAttachments: readonly PendingAttachment[],
): boolean {
  return stagedQuotes.length > source.originalQuotes.length ||
    stagedAttachments.length > source.originalAttachments.length;
}

/**
 * Stage the selected message's quotes and attachments into the composer
 * plates: the carried context becomes visible and explicitly removable
 * (#5109). Returns the source snapshot the draft records for the unchanged
 * comparison. Refuses nothing — the caller has already established that the
 * plates were empty of user-staged context.
 */
export function stageRevisionSourceContext(
  staged: RevisionStagedContext,
  ownerKey: string,
  quotes: readonly QuoteRef[] | undefined,
  attachments: readonly AttachmentRef[] | undefined,
): RevisionStagedSource {
  const sourceQuotes = [...(quotes ?? [])];
  const sourceAttachments = [...(attachments ?? [])];
  if (sourceQuotes.length > 0) staged.restoreQuotes(ownerKey, sourceQuotes);
  if (sourceAttachments.length > 0) staged.restoreAttachments(ownerKey, sourceAttachments);
  return { originalQuotes: sourceQuotes, originalAttachments: sourceAttachments };
}

/**
 * Swap the staged source-owned attachment refs for the copied message's
 * target-owned ones after the revision commit: the branch child transcript
 * carries the rewritten refs, so the replacement submit only claims files
 * the new Session owns. The branch child must be the active surface — the
 * staging mutators bind to its draft key.
 */
export function restageRevisionAttachments(
  staged: RevisionStagedContext,
  copiedMessages: readonly StoredMessage[],
  sourceTurnId: string,
  targetSessionId: string,
): void {
  const copiedMessage = copiedMessages.find(
    (message): message is Extract<StoredMessage, { type: 'user' }> =>
      message.type === 'user' && message.turnId === sourceTurnId,
  );
  const rewritten = [...(copiedMessage?.attachments ?? [])];
  for (let index = staged.attachments.length - 1; index >= 0; index -= 1) {
    staged.removeAttachment(index);
  }
  if (rewritten.length > 0) staged.restoreAttachments(targetSessionId, rewritten);
}

/**
 * The pre-send gate for a revision replacement: 'unchanged' blocks a no-op
 * retry that would duplicate the source turn verbatim; 'conflict' blocks a
 * send mixing user-staged context into the restored set (pending directories
 * have no plate snapshot — flagged through pendingContext with an empty
 * attachment plate).
 */
export function revisionSendGate(
  source: RevisionStagedSource,
  originalText: string,
  text: string,
  stagedQuotes: readonly QuoteRef[],
  stagedAttachments: readonly PendingAttachment[],
  pendingContext: boolean,
): 'pass' | 'unchanged' | 'conflict' {
  if (revisionStagedContextUnchanged(source, originalText, text, stagedQuotes, stagedAttachments)) {
    return 'unchanged';
  }
  if (
    stagedQuotes.length > source.originalQuotes.length ||
    stagedAttachments.length > source.originalAttachments.length ||
    (pendingContext && stagedAttachments.length === 0)
  ) {
    return 'conflict';
  }
  return 'pass';
}

/**
 * Unstage everything the edit staged and restore what it displaced — the
 * cancel path. The plates hold only the edit's items, because editing is
 * refused while the user has own context staged.
 */
export function clearRevisionStagedContext(
  staged: RevisionStagedContext,
  previousQuotes: readonly QuoteRef[],
  ownerKey: string,
): void {
  for (let index = staged.attachments.length - 1; index >= 0; index -= 1) {
    staged.removeAttachment(index);
  }
  for (let index = staged.quotes.length - 1; index >= 0; index -= 1) {
    staged.removeQuote(index);
  }
  if (previousQuotes.length > 0) staged.restoreQuotes(ownerKey, previousQuotes);
}
