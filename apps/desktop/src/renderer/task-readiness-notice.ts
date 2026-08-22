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

import type { SessionSendProjection } from '@maka/core/session-send-projection';

import type { TaskSubmissionReadinessDimension, TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';

import type { UiLocale } from '@maka/core/ui-locale';

/**
 * Selects the model target for the renderer's readiness probe. A `rebind`
 * projection supplies a compatible target for an empty legacy session; it
 * does not mutate the session or admit the submission. Runtime Host owns
 * those decisions.
 */
export function resolveTaskReadinessModelTarget(
  session: { llmConnectionSlug: string; model: string } | undefined,
  sendOutcome: SessionSendProjection | undefined,
  newTaskTarget: { llmConnectionSlug: string; model: string } | undefined,
): { connectionSlug?: string; model?: string } {
  if (session && sendOutcome?.kind === 'rebind') {
    return optionalModelTarget(sendOutcome.connectionSlug, sendOutcome.model);
  }
  return optionalModelTarget(
    session?.llmConnectionSlug ?? newTaskTarget?.llmConnectionSlug,
    session?.model ?? newTaskTarget?.model,
  );
}

function optionalModelTarget(
  connectionSlug: string | undefined,
  model: string | undefined,
): { connectionSlug?: string; model?: string } {
  return {
    ...(connectionSlug?.trim() ? { connectionSlug: connectionSlug.trim() } : {}),
    ...(model?.trim() ? { model: model.trim() } : {}),
  };
}

export interface TaskReadinessNotice {
  tone: 'warning' | 'destructive';
  title: string;
  description: string;
  actionLabel: string;
  action: 'retry' | 'workspace_picker';
}

export function isTaskSubmissionHardBlocked(
  snapshot: TaskSubmissionReadinessSnapshot | undefined,
  options: { ignoreModelTarget?: boolean } = {},
): boolean {
  return (
    snapshot?.blockers.some(
      (blocker) =>
        blocker.state !== 'unknown' &&
        !(options.ignoreModelTarget === true && blocker.id === 'model_target'),
    ) === true
  );
}

/** Model blockers already have connection-specific recovery surfaces. */
export function deriveTaskReadinessNotice(
  snapshot: TaskSubmissionReadinessSnapshot | undefined,
  locale: UiLocale,
): TaskReadinessNotice | undefined {
  if (!snapshot) return undefined;
  const blocker = snapshot.blockers.find(
    (candidate) =>
      candidate.state !== 'unknown' &&
      (candidate.id === 'runtime' || candidate.id === 'workspace'),
  );
  if (!blocker) return undefined;
  return noticeForBlocker(blocker, locale);
}

function noticeForBlocker(
  blocker: TaskSubmissionReadinessDimension,
  locale: UiLocale,
): TaskReadinessNotice {
  if (blocker.id === 'runtime') {
    return locale === 'zh'
      ? {
          tone: 'destructive',
          title: 'Maka 运行服务暂时不可用。',
          description: '任务尚未提交。重新检测运行服务后再试。',
          actionLabel: '重新检测',
          action: 'retry',
        }
      : {
          tone: 'destructive',
          title: 'The Maka runtime is unavailable.',
          description: 'The task was not submitted. Check the runtime again before retrying.',
          actionLabel: 'Check again',
          action: 'retry',
        };
  }
  const action = blocker.repairTarget?.kind === 'workspace_picker' ? 'workspace_picker' : 'retry';
  return locale === 'zh'
    ? {
        tone: 'destructive',
        title: '当前任务的工作区不可用。',
        description: '原目录可能已移动、删除或无法访问。请选择可用工作区。',
        actionLabel: action === 'workspace_picker' ? '选择工作区' : '重新检测',
        action,
      }
    : {
        tone: 'destructive',
        title: 'This task workspace is unavailable.',
        description: 'The folder may have moved, been deleted, or become inaccessible. Choose an available workspace.',
        actionLabel: action === 'workspace_picker' ? 'Choose workspace' : 'Check again',
        action,
      };
}
