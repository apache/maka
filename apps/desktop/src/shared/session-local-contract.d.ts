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

import type {
  AttachmentRef,
  DirectoryReference,
  InlineReference,
  QuoteRef,
} from '@maka/core/events';
import type { DesktopTranscriptBatchPayload } from '../preload/transcript-contract.js';

export type DesktopLocalMessageState = 'saved' | 'sending' | 'accepted' | 'unknown' | 'failed';

/** Presentation only; the durable command and attachment bytes stay in Main. */
export interface DesktopLocalMessage {
  readonly sessionId: string;
  readonly messageId: string;
  readonly createdAt: number;
  readonly state: DesktopLocalMessageState;
  readonly canCancel: boolean;
  readonly placement: 'current_turn' | 'next_turn';
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  readonly directoryReferences?: readonly DirectoryReference[];
  readonly quotes?: readonly QuoteRef[];
  readonly inlineReferences: readonly InlineReference[];
  readonly turnId?: string;
  readonly admission?: 'turn_started' | 'steering' | 'followup';
  readonly checking?: boolean;
  readonly retryScheduled?: boolean;
  readonly waitingForConnection?: boolean;
  readonly error?: string;
}

/** Read on demand for editing a definite failure; reading never consumes the original. */
export interface DesktopLocalMessageDraft {
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  readonly stagedAttachments: readonly { name: string; mimeType: string; content: Uint8Array }[];
  readonly directoryReferences: readonly DirectoryReference[];
  readonly quotes: readonly QuoteRef[];
  readonly inlineReferences: readonly InlineReference[];
}

export interface DesktopCachedTranscript {
  readonly cachedAt: number;
  readonly batches: readonly DesktopTranscriptBatchPayload[];
}

export interface DesktopSessionLocalBridge {
  listMessages(sessionId: string): Promise<readonly DesktopLocalMessage[]>;
  readFailedMessage(sessionId: string, messageId: string): Promise<DesktopLocalMessageDraft>;
  /** Only an intent that has never been dispatched can be cancelled locally. */
  cancelMessage(sessionId: string, messageId: string): Promise<void>;
  /** Reconcile the same immutable command; never turn an unknown outcome into a new execution. */
  reconcileMessage(sessionId: string, messageId: string): Promise<void>;
  readTranscript(sessionId: string): Promise<DesktopCachedTranscript | null>;
  subscribeChanges(handler: (sessionId: string) => void): () => void;
}
