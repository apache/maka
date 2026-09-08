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

export const transcriptReadingPosition = {
  currentRange: currentTranscriptRange,
  restoreTarget: transcriptRestoreTarget,
};

export type {
  TranscriptHistoryPending,
} from './controller/transcript-reading-position.js';
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

export { useComposerAttachments, type ComposerAttachmentService } from './controller/use-composer-attachments.js';
export { toComposerIngestItems, retainedAttachmentRefs, type PendingAttachment } from '@maka/ui/composer-attachments';
export { NEW_TASK_PENDING_KEY, selectPending, appendPending, removePending, removePendingItems, clearPending, type PendingByKey } from '@maka/ui/pending-items';
export { desktopSlashCommandPresentation } from './model/slash-command-presentation.js';

export { composerFollowUp } from './controller/composer-follow-up.js';
