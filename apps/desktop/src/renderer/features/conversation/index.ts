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

export { resolveTaskReadinessModelTarget } from './model/task-readiness-notice.js';
export type { AppShellSessionUiStateController } from './model/session-ui-state.js';
export type { SessionUiReads } from './model/session-ui-reads.js';
export { useAppShellSessionUiReads } from './controller/use-session-ui-reads.js';
export type { ConversationHostChange, ConversationServices } from './ports.js';
export { ConversationServicesProvider } from './services.js';


export type { ComposerAttachmentService } from '@maka/ui/use-composer-attachments';
export {
  NEW_TASK_PENDING_KEY,
  selectPending,
  appendPending,
  removePending,
  removePendingItems,
  clearPending,
} from '@maka/ui/pending-items';
export { desktopSlashCommandPresentation } from './model/slash-command-presentation.js';
export { useActiveExecutionBoundary } from './controller/use-active-execution-boundary.js';
export { useShellResume } from './controller/use-shell-resume.js';
export { useSessionReferenceComposer } from './controller/use-session-reference-composer.js';
export {
  ComposerMentionsProvider,
  useComposerMentionsContext,
  type ComposerMentions,
  type ComposerMentionsSurface,
} from './ui/composer-mentions-provider.js';

export { chatTurnActivity } from '../../application/contracts/session-execution.js';
export { sessionIdSetsEqual, type LiveTurnSnapshot } from './model/live-turn-snapshot.js';
export { createAppShellQueueActions } from './controller/app-shell-queue-actions.js';
export * from './model/observation-visibility.js';

export { useExecutorSelection } from './controller/use-executor-selection.js';
export * from './model/shell-chat-model-selection.js';
export * from './model/session-health-notice.js';
export * from './controller/use-shell-chat-model.js';
export * from './model/executor-submission.js';
export * from './model/executor-composer.js';

export { PlanProvider } from './ui/plan-provider.js';
export { PlanChatView, PlanExecutionSurface } from './ui/plan-surfaces.js';
export { PlanServicesProvider } from './plan-services.js';
export type { PlanServices } from './plan-ports.js';

export type { ConversationObservationServices } from './transcript-ports.js';

export { ConversationProvider } from './ui/conversation-provider.js';
export { useConversationTarget as useAppShellSessionUiState } from './controller/use-conversation-target.js';

export { ConversationLifecycle } from './ui/conversation-lifecycle.js';

export { ConversationTranscriptRegion, ConversationComposerRegion, ConversationMessageConsumer } from './ui/conversation-readers.js';
export { createComposerStagingCommands } from './controller/composer-staging-commands.js';
export type { ComposerStagingCommands, ComposerStagingSubmission } from './model/composer-staging-contract.js';
export { ComposerStagingServicesProvider, type ComposerStagingServices } from './staging-services.js';
export { ComposerStagingProvider } from './ui/composer-staging-provider.js';
export { StagedComposer, type ComposerStagingProp } from './ui/staged-composer.js';
export { StagedQuoteChatView } from './ui/staged-quote-chat-view.js';
export { TaskReadinessServicesProvider, type TaskReadinessServices } from './readiness-services.js';
export { TaskReadinessProvider, TaskReadinessNoticeConsumer } from './ui/task-readiness-provider.js';
export { createComposerSubmissionCommands } from './controller/composer-submission-commands.js';
export { ComposerSubmissionServicesProvider, type ComposerSubmissionServices } from './submission-services.js';
export { ComposerSubmissionProvider } from './ui/composer-submission-provider.js';
