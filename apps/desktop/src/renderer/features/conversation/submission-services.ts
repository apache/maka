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

import type { AttachmentIngestBlockedCode } from '@maka/core/attachments';
import type { AttachmentRef, DirectoryReference, InlineReference, QuoteRef } from '@maka/core/events';
import type { CreateSessionRequestInput, TurnOrchestration } from '@maka/core/runtime-inputs';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { SkillInvocationResult } from '@maka/runtime/skill-invocation';
import type { ComposerIngestInput } from '@maka/ui/composer-attachments';
import { createServicesContext } from '../../application/contracts/feature-services.js';
import type { DesktopSessionSummary } from '../../../shared/desktop-session-projection.js';
import type { ConversationNewTaskTarget } from './ports.js';

export type MessagePlacement = 'current_turn' | 'next_turn';

/** One Message as the Composer submits it; the Host decides its admission. */
export interface ConversationMessageCommand {
  readonly messageId: string;
  readonly text: string;
  readonly localDisplayPlacement?: MessagePlacement;
  readonly displayText?: string;
  readonly turnOrchestration?: TurnOrchestration;
  readonly attachmentItems?: ComposerIngestInput[];
  readonly retainedAttachments?: AttachmentRef[];
  readonly directoryReferences?: DirectoryReference[];
  readonly quotes?: QuoteRef[];
  readonly workspaceFileReferences?: Array<Pick<InlineReference, 'value' | 'start'>>;
}

export type ConversationMessageSubmission =
  | {
      readonly ok: true;
      readonly disposition: 'turn_started' | 'steering' | 'followup' | 'locally_saved';
      readonly turnId?: string;
      readonly attachments: AttachmentRef[];
      readonly inlineReferences: InlineReference[];
      readonly skillInvocation: SkillInvocationResult;
    }
  | { readonly ok: false; readonly reason: 'skill_invocation_failed'; readonly skillInvocation: SkillInvocationResult }
  | { readonly ok: false; readonly reason: 'attachment_blocked'; readonly code: AttachmentIngestBlockedCode }
  | { readonly ok: false; readonly reason: 'outcome_unknown' };

/** What a Stop retracted, so the Composer can drop the matching pending rows. */
export type ConversationStopResult =
  | { readonly kind: 'retracted'; readonly messageId: string }
  | { readonly kind: 'interrupted'; readonly retractedMessageIds: readonly string[] }
  | undefined;

/**
 * The Host operations behind the Composer's sends, edit-and-resend, Stop, Turn
 * branching and interaction answers. Each is one named operation; the owner never receives a
 * bridge namespace.
 */
export interface ComposerSubmissionServices {
  submitMessage(
    sessionId: string,
    placement: MessagePlacement,
    command: ConversationMessageCommand,
    options?: { readonly waitForHostAdmission?: boolean },
  ): Promise<ConversationMessageSubmission>;
  createNewTask(target: ConversationNewTaskTarget, input: CreateSessionRequestInput): Promise<DesktopSessionSummary>;
  /** Deletes a Session whose first Message never landed. */
  removeUnsentSession(sessionId: string): Promise<unknown>;
  reviseBeforeTurn(
    sessionId: string,
    input: { readonly sourceTurnId: string; readonly copyId: string },
  ): Promise<DesktopSessionSummary>;
  abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void>;
  stop(
    sessionId: string,
    input: { readonly source: 'stop_button'; readonly expectedTurnId?: string },
  ): Promise<ConversationStopResult>;
  branchFromTurn(
    sessionId: string,
    input: { readonly sourceTurnId: string; readonly copyId: string },
  ): Promise<DesktopSessionSummary>;
  respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void>;
}

const context = createServicesContext<ComposerSubmissionServices>('ComposerSubmissionServicesProvider');
export const ComposerSubmissionServicesProvider = context.Provider;
export const useComposerSubmissionServices = context.useServices;
