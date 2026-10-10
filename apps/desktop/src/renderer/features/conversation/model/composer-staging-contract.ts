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

import type { DirectoryReference, QuoteRef } from '@maka/core/events';
import type { PendingAttachment } from '@maka/ui/composer-attachments';
import type { RevisionStagedContext } from '@maka/ui';
import type { RestoredDraftContent } from '../../../application/contracts/transient-message-projection.js';

/** A submission owns the staging it captured, even after navigation or another edit. */
export interface ComposerStagingSubmission {
  readonly draftKey: string;
  readonly hasPendingContext: boolean;
  readonly hasStagedQuotes: boolean;
  readonly submittableAttachments: readonly PendingAttachment[] | undefined;
  readonly directoryOptions: { readonly directoryReferences?: readonly DirectoryReference[] };
  /** Without an owner key this answers from the captured snapshot; the
   *  revision send passes the branch child's key because the lifecycle
   *  re-keys the plate mid-send and empties the source bucket, so the
   *  resumed send must read the live plate through the new owner
   *  (#5274 review). */
  quotesForSend(ownerKey?: string): QuoteRef[] | undefined;
  clearSubmittedContext(submitted?: readonly PendingAttachment[]): void;
  /** Without an owner key this removes exactly the captured entries; an
   *  explicit owner key clears that owner's whole live plate (the revision
   *  path clears the branch child the lifecycle re-keyed the quotes onto). */
  clearQuotes(ownerKey?: string): void;
}

/** Commands only: there is deliberately no subscription or controller getter. */
export interface ComposerStagingCommands {
  captureSubmission(): ComposerStagingSubmission;
  /** Live plate reads for the revision lifecycle, assembled beside the hooks
   *  that own the buckets (see RevisionStagedContext). */
  stagedContext(): RevisionStagedContext;
  addQuote(input: {
    text: string;
    turnId?: string;
    label?: string;
    comment?: string;
  }): void;
  resetImageNotice(draftKey: string): void;
  transferImageNotice(from: string, to: string): void;
  /** Hands a withdrawn send's attachments, directories and quotes back to the draft it left. */
  restoreContext(draftKey: string, context: Omit<RestoredDraftContent, 'text'>): void;
}
