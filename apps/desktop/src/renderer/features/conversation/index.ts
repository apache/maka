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
  currentTranscriptRange,
  transcriptRestoreTarget,
} from './controller/transcript-reading-position.js';

export { TranscriptReadSupersededError } from './controller/transcript-reading-position.js';

export const transcriptReadingPosition = {
  currentRange: currentTranscriptRange,
  restoreTarget: transcriptRestoreTarget,
};

export {
  TranscriptReadingPositionController,
  type TranscriptReadingPositionCommands,
} from './controller/transcript-reading-position-controller.js';

export {
  deriveTaskReadinessNotice,
  isTaskSubmissionHardBlocked,
  resolveTaskReadinessModelTarget,
  type TaskReadinessNotice,
} from './model/task-readiness-notice.js';
export * from './model/session-ui-state.js';
export type { ConversationServices } from './ports.js';
export { ConversationServicesProvider } from './services.js';
export { SessionLocalMessages } from './controller/session-local-messages.js';
export { createConversationDisplayFrameScheduler } from './controller/display-frame-scheduler.js';
export { useAppShellSessionUiState } from './controller/use-app-shell-session-ui-state.js';

export { useComposerAttachments, type ComposerAttachmentService } from './controller/use-composer-attachments.js';
export { type PendingAttachment, toComposerIngestItems, retainedAttachmentRefs } from '@maka/ui/composer-attachments';
export {
  type PendingByKey,
  NEW_TASK_PENDING_KEY,
  selectPending,
  appendPending,
  removePending,
  removePendingItems,
  clearPending,
} from '@maka/ui/pending-items';
export { desktopSlashCommandPresentation } from './model/slash-command-presentation.js';

export { activeHostTurn, chatTurnActivity } from '../../application/contracts/session-execution.js';
export { selectLiveTurns, sessionUiSelectors } from './model/session-ui-selectors.js';
export { LiveTurnReconciler } from './controller/live-turn-reconciler.js';
export { sessionIdSetsEqual, type LiveTurnSnapshot } from './model/live-turn-snapshot.js';
