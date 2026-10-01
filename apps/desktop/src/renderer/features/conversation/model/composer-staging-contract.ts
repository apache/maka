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

/** A submission owns the staging it captured, even after navigation or another edit. */
export interface ComposerStagingSubmission {
  readonly draftKey: string;
  readonly hasPendingContext: boolean;
  readonly hasStagedQuotes: boolean;
  readonly submittableAttachments: readonly PendingAttachment[] | undefined;
  readonly directoryOptions: { readonly directoryReferences?: readonly DirectoryReference[] };
  quotesForSend(): QuoteRef[] | undefined;
  clearSubmittedContext(submitted?: readonly PendingAttachment[]): void;
  clearQuotes(): void;
}

/** Commands only: there is deliberately no subscription or controller getter. */
export interface ComposerStagingCommands {
  captureSubmission(): ComposerStagingSubmission;
  addQuote(input: {
    text: string;
    turnId?: string;
    label?: string;
    comment?: string;
  }): void;
  resetImageNotice(draftKey: string): void;
  transferImageNotice(from: string, to: string): void;
}
