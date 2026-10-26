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

import { createContext, createElement, useContext, useMemo, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { Composer, getWorktreeCopy } from '@maka/ui';
import { getTaskReadinessCopy } from '../../../locales/task-readiness-copy.js';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import { useUiLocale } from '@maka/ui';
import { useTaskSubmissionReadiness } from '../controller/use-task-submission-readiness.js';
import { deriveTaskReadinessNotice } from '../model/task-readiness-notice.js';
import type { ConversationNewTaskTarget } from '../ports.js';
import { useTaskReadinessServices, type TaskReadinessRequest } from '../readiness-services.js';
import { useCurrentOnboardingSnapshot } from '../../../application/contracts/onboarding/onboarding-authority.js';

interface TaskReadinessOwner {
  readonly sessionId?: string;
  readonly workspaceFixed?: boolean;
  readonly snapshot: TaskSubmissionReadinessSnapshot | undefined;
  readonly refresh: () => void;
  readonly openWorkspacePicker: (() => void) | undefined;
}

// Module-local: only the notice and Composer leaves read this snapshot.
const TaskReadinessContext = createContext<TaskReadinessOwner | undefined>(undefined);

/**
 * Sole owner of the Composer's task readiness. It stays mounted beside
 * `ComposerStagingProvider`, so section switches and transcript unmounts
 * neither restart nor drop the read. AppShell supplies the request projection,
 * the targets and the stable workspace-recovery commands; it receives no
 * snapshot. A new onboarding snapshot from the application onboarding
 * authority reads again.
 */
export function TaskReadinessProvider(props: {
  readonly request: TaskReadinessRequest;
  readonly sessionId?: string;
  readonly newTaskTarget?: ConversationNewTaskTarget;
  /** A workspace blocker on this Session opens its workspace recovery. */
  readonly workspaceRecoverySessionId?: string;
  readonly openSessionWorkspaceRecovery: (sessionId: string) => void;
  /** Without a Session, a workspace blocker adds a project; absent when it cannot. */
  readonly addProject?: () => void;
  readonly children?: ReactNode;
}) {
  const { snapshot, refresh } = useTaskSubmissionReadiness(
    useTaskReadinessServices(),
    props.request,
    useCurrentOnboardingSnapshot(),
    props.sessionId,
    props.newTaskTarget,
  );
  const { workspaceRecoverySessionId: recoverySessionId, openSessionWorkspaceRecovery, addProject } = props;
  // Facts and stable commands, so a shell render with the same Session and
  // permission leaves the notice reader alone.
  const openWorkspacePicker = useMemo(
    () => props.request.workspaceFixed ? undefined : recoverySessionId ? () => openSessionWorkspaceRecovery(recoverySessionId) : addProject,
    [recoverySessionId, openSessionWorkspaceRecovery, addProject, props.request.workspaceFixed],
  );
  const owner = useMemo<TaskReadinessOwner>(
    () => ({ snapshot, refresh, openWorkspacePicker, sessionId: props.sessionId, workspaceFixed: props.request.workspaceFixed }),
    [snapshot, refresh, openWorkspacePicker, props.request.workspaceFixed, props.sessionId],
  );
  return <TaskReadinessContext.Provider value={owner}>{props.children}</TaskReadinessContext.Provider>;
}

export interface TaskReadinessNoticeView {
  readonly status: 'error' | 'warning';
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onAction?: () => void;
}

/**
 * Runtime and workspace blockers render through
 * `surface`; a workspace blocker opens the picker, every other action reads
 * readiness again.
 */
export function TaskReadinessNoticeConsumer(props: { readonly surface: ComponentType<TaskReadinessNoticeView> }) {
  const locale = useUiLocale();
  const owner = useContext(TaskReadinessContext);
  if (!owner) throw new Error('TaskReadinessProvider is required');
  const notice = deriveTaskReadinessNotice(owner.snapshot, locale);
  if (!notice) return null;
  const fixedWorkspace = owner.workspaceFixed && owner.snapshot?.blockers.find(
    (blocker) => blocker.state !== 'unknown' && (blocker.id === 'runtime' || blocker.id === 'workspace'),
  )?.id === 'workspace';
  const worktree = getWorktreeCopy(locale);
  return createElement(props.surface, {
    status: notice.tone === 'destructive' ? 'error' : 'warning',
    title: fixedWorkspace ? worktree.fixedUnavailable : notice.title,
    description: fixedWorkspace ? '' : notice.description,
    actionLabel: fixedWorkspace ? getTaskReadinessCopy(locale).workspace.actionLabel.retry : notice.actionLabel,
    onAction: !fixedWorkspace && notice.action === 'workspace_picker' ? owner.openWorkspacePicker : owner.refresh,
  });
}

/** Keep the draft editable, but block both submit paths for a missing workspace. */
export function TaskReadinessComposer(props: ComponentProps<typeof Composer>) {
  const owner = useContext(TaskReadinessContext);
  const locale = useUiLocale();
  const blocked = owner?.sessionId === props.draftKey && owner?.snapshot?.blockers.some(
    (blocker) => blocker.id === 'workspace' && blocker.state !== 'unknown',
  );
  const reason = owner?.workspaceFixed
    ? getWorktreeCopy(locale).fixedUnavailable
    : getTaskReadinessCopy(locale).workspace.title;
  return <Composer {...props}
    sendBlocked={props.sendBlocked || blocked}
    sendBlockedReason={blocked ? reason : props.sendBlockedReason}
  />;
}
