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
import { getTaskReadinessCopy } from '../../../locales/task-readiness-copy.js';

/** Selects the stored model target for the renderer's readiness probe. */
export function resolveTaskReadinessModelTarget(
  session: { llmConnectionSlug: string; model: string } | undefined,
  _sendOutcome: SessionSendProjection | undefined,
  newTaskTarget: { llmConnectionSlug: string; model: string } | undefined,
): { connectionSlug?: string; model?: string } {
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
  const copy = getTaskReadinessCopy(locale);
  if (blocker.id === 'runtime') {
    return {
      tone: 'destructive',
      title: copy.runtime.title,
      description: copy.runtime.description,
      actionLabel: copy.runtime.actionLabel,
      action: 'retry',
    };
  }
  const action = blocker.repairTarget?.kind === 'workspace_picker' ? 'workspace_picker' : 'retry';
  return {
    tone: 'destructive',
    title: copy.workspace.title,
    description: copy.workspace.description,
    actionLabel: copy.workspace.actionLabel[action],
    action,
  };
}
