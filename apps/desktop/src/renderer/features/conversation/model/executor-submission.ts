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

import type { ExecutorCatalogEntry, ExecutorSelection } from '@maka/core/executor-catalog';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { NewChatModel } from './shell-chat-model-selection.js';
import type { SessionSummary } from '@maka/core/session';

/** Adopt the submitted catalog before the locally created Session becomes visible. */
export function createExecutorSessionActivator<Session extends SessionSummary>(
  executor: { adoptSession(session: SessionSummary): void },
  commitSession: (session: Session) => void,
  selectNavigation: (selection: { section: 'sessions' }) => void,
  activateSession: (sessionId: string) => void,
): (session: Session) => Promise<void> {
  return async session => {
    executor.adoptSession(session);
    commitSession(session);
    selectNavigation({ section: 'sessions' });
    activateSession(session.id);
  };
}

export interface ExecutorSubmission {
  executorSelection?: ExecutorSelection;
  executorEntry?: Pick<ExecutorCatalogEntry, 'readiness' | 'supportsAttachments'> &
    Partial<Pick<ExecutorCatalogEntry, 'models' | 'modes'>>;
}

const SUBMISSION_COPY = {
  en: {
    attachments: 'Remove unsupported attachments or select Maka. Your draft is preserved.',
    unavailable: 'Check External Agents settings or start a new task.',
    invalid: 'The selected Agent configuration is no longer available. Choose again.',
  },
  'zh-CN': {
    attachments: '请移除不支持的附件或选择 Maka，草稿会保留。',
    unavailable: '请检查外部 Agent 设置，或新建任务。',
    invalid: '所选 Agent 配置已失效，请重新选择。',
  },
  'zh-TW': {
    attachments: '請移除不支援的附件或選擇 Maka，草稿會保留。',
    unavailable: '請檢查外部 Agent 設定，或建立新任務。',
    invalid: '所選 Agent 設定已失效，請重新選擇。',
  },
} satisfies UiCatalog<{ attachments: string; unavailable: string; invalid: string }>;

export function executorSubmissionError(
  input: ExecutorSubmission,
  attachments: number,
  locale: UiLocale,
): string | undefined {
  if (!input.executorSelection) return;
  const entry = input.executorEntry;
  if (!entry || entry.readiness !== 'ready') return SUBMISSION_COPY[locale].unavailable;
  if (attachments && !entry.supportsAttachments) return SUBMISSION_COPY[locale].attachments;
  const { model, mode } = input.executorSelection.configuration;
  if ((model && entry.models && !entry.models.some(candidate => candidate.id === model)) ||
    (mode && !entry.modes?.some(candidate => candidate.id === mode)))
    return SUBMISSION_COPY[locale].invalid;
}

export function newTaskConfiguration(
  input: ExecutorSubmission & {
    newChatModel: NewChatModel | { executorId: string; model: string } | null;
    pendingNewChatThinkingLevel: ThinkingLevel | null | undefined;
    newChatPermissionChoice: ChatDefaultPermissionMode | undefined;
    newChatCollaborationMode: CollaborationMode;
    newChatOrchestrationMode: OrchestrationMode;
  },
) {
  const executor = input.executorSelection;
  return {
    ...(executor
      ? { executorId: executor.executorId, executorConfig: executor.configuration }
      : { ...(input.newChatModel ?? {}), executorConfig: undefined }),
    ...(!executor ? { thinkingLevel: input.pendingNewChatThinkingLevel } : {}),
    ...(input.newChatPermissionChoice ? { permissionMode: input.newChatPermissionChoice } : {}),
    collaborationMode: executor ? ('agent' as const) : input.newChatCollaborationMode,
    orchestrationMode: executor ? ('default' as const) : input.newChatOrchestrationMode,
  };
}

export function canSubmitExecutor(
  input: ExecutorSubmission & { uiLocale: UiLocale; toastApi: { error(message: string): void } },
  attachments: number,
): boolean {
  const error = executorSubmissionError(input, attachments, input.uiLocale);
  if (error) input.toastApi.error(error);
  return !error;
}
