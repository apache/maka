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

import type { ArtifactBinaryReadResult } from '@maka/core/artifacts';
import type { UiLocale } from '@maka/core/ui-locale';
import type { StoredMessage, SessionSummary } from '@maka/core/session';
import type { ComposerAttachmentService } from '@maka/ui/use-composer-attachments';
import type { SessionEvent, AttachmentRef } from '@maka/core/events';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { OperationInput, OperationOutput } from '@maka/runtime-host/protocol';
import type { WorkHubAnswerInput, WorkHubAnswerResult } from '../../../shared/workhub-conversation.js';
import type { WorkHubControlBridge } from '../../../shared/workhub-control.js';
import type { WorkHubPresentationBridge } from '../../../shared/workhub-presentation.js';
import type { WorkHubCoordinationHostChange } from './controller/coordination-lifecycle.js';

export interface WorkHubTranscriptSnapshot {
  readonly messages: readonly StoredMessage[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly ready: boolean;
}
export interface WorkHubTranscript {
  observationChanged(phase: 'pending' | 'ready'): void;
  loadOlder(): Promise<void>;
  loadLatest(): Promise<void>;
  close(): Promise<void>;
}
export interface WorkHubServices {
  readonly surface: 'main' | 'workhub';
  readonly initialLocale: UiLocale;
  subscribeAppearance(handler: (locale: UiLocale) => void): () => void;
  readonly presentation: WorkHubPresentationBridge;
  readonly control: WorkHubControlBridge;
  resolve(): Promise<string>;
  getSession(sessionId: string): Promise<SessionSummary & { revision: number }>;
  subscribeHosts(handler: (event: WorkHubCoordinationHostChange) => void): () => void;
  subscribeAvailability(handler: () => void): () => void;
  listSessions(): Promise<(SessionSummary & { revision: number })[]>;
  subscribeSessions(handler: () => void): () => void;
  modelChoices(sessionId: string): Promise<ChatModelChoice[]>;
  readonly attachments: ComposerAttachmentService;
  readAttachmentBytes(sessionId: string, artifactId: string): Promise<ArtifactBinaryReadResult>;
  prepareAttachments(sessionId: string, items: Array<{ approvalId: string; name: string; mimeType?: string } | { file: File }>): Promise<AttachmentRef[]>;
  answer(sessionId: string, input: WorkHubAnswerInput): Promise<WorkHubAnswerResult>;
  steer(sessionId: string, messageId: string, text: string, attachments: AttachmentRef[]): Promise<'admitted' | 'unknown' | 'rejected'>;
  retractQueueEntry(sessionId: string, entryId: string): Promise<void>;
  promoteQueueEntry(sessionId: string, entryId: string): Promise<void>;
  updateQueueEntry(sessionId: string, entryId: string, expectedQueueRevision: number, text: string): Promise<void>;
  reorderQueueEntries(sessionId: string, entryIds: readonly string[]): Promise<void>;
  configureModel(
    sessionId: string,
    input: OperationInput<'workhub.coordination.configureModel'>,
  ): Promise<OperationOutput<'workhub.coordination.configureModel'>>;
  observe(
    sessionId: string,
    handler: (event: SessionEvent) => void,
    onError: (error: unknown) => void,
    onPhase: (phase: 'pending' | 'ready') => void,
  ): () => void;
  openTranscript(
    sessionId: string,
    handler: (snapshot: WorkHubTranscriptSnapshot) => void,
    signal: AbortSignal,
    onError: (error: unknown) => void,
  ): Promise<WorkHubTranscript>;
  stop(sessionId: string, turnId: string): Promise<unknown>;
}
