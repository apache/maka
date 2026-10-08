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

import type { CollaborationMode } from '@maka/core/collaboration';
import type { InteractionFormResponse } from '@maka/core/interaction';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { ToastDiagnosticTarget, TurnFooterActionMeta } from '@maka/ui';
import type { DesktopSessionSummary } from '../../../../shared/desktop-session-projection.js';
import type { NewChatExecutionTarget } from '../controller/use-shell-chat-model.js';
import type { ConversationNewTaskTarget } from '../ports.js';
import type { ExecutorSubmission } from './executor-submission.js';

/** The shell surface a send started on; only the shell can say whether it is still current. */
export interface ComposerSurfaceOwner {
  readonly sessionId: string | undefined;
  readonly newTaskDraftKey?: string;
}

/** Commands only: the shell gets no draft, pending flag or setter through this handle. */
export interface ComposerSubmissionCommands {
  beginEditUserMessage(turnId: string): void;
  handleTurnFooterAction(turnId: string, actionId: TurnFooterActionMeta['id']): Promise<void>;
  /** Drops the pending Turn-footer marks of one retired Session. */
  clearPendingTurnActions(sessionId: string): void;
}

/**
 * What the shell supplies to submission: navigation, the Session catalog, and
 * other features' commands. Each is a named operation it already owns.
 */
export interface ComposerSubmissionShell<Owner extends ComposerSurfaceOwner> {
  captureOwner(): Owner;
  /** Whether the user is still on the surface the owner was captured from. */
  isOwnerActive(owner: Owner): boolean;
  /** The same question, for an owner captured on the new-chat surface. */
  isNewChatOwnerActive(owner: Owner): boolean;
  activateFirstSendSession(session: DesktopSessionSummary): Promise<void>;
  openSession(sessionId: string, turnId?: string): void;
  /** Drops a Session's renderer state after its unsent first message was retracted. */
  retireSession(sessionId: string): void;
  refreshSessions(): Promise<unknown>;
  reloadExecutionBoundary(sessionId: string): void;
  respondToUserForm(sessionId: string, response: InteractionFormResponse): Promise<void>;
  showModelSetupToast(description: string, reason?: string, diagnosticTarget?: ToastDiagnosticTarget): void;
  bindNewTaskSessionResolver(selectionRevision: number): (sessionId: string, newTaskDraftKey?: string) => void;
  openSideChat(options: { initialPrompt?: string }): void;
  orchestrationMode(): OrchestrationMode;
  setOrchestrationModeActive(mode: Exclude<OrchestrationMode, 'default'>, active: boolean): Promise<boolean>;
}

/** What a new task is created with, read when its first send starts. */
export interface ComposerNewTaskSubmission extends ExecutorSubmission {
  readonly target: ConversationNewTaskTarget | undefined;
  readonly model: NewChatExecutionTarget | null;
  /** Undefined applies the Host's model default; null keeps the provider default. */
  readonly thinkingLevel: ThinkingLevel | null | undefined;
  readonly permissionChoice: ChatDefaultPermissionMode | undefined;
  readonly collaborationMode: CollaborationMode;
  readonly orchestrationMode: OrchestrationMode;
  /** Drops the permission choice once a created Session has consumed it. */
  clearPermissionChoice(): void;
}
