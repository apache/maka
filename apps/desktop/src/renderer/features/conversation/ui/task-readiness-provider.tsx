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

import { createContext, createElement, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import { useUiLocale } from '@maka/ui';
import { useTaskSubmissionReadiness } from '../controller/use-task-submission-readiness.js';
import { deriveTaskReadinessNotice } from '../model/task-readiness-notice.js';
import type { ConversationNewTaskTarget } from '../ports.js';
import { useTaskReadinessServices, type TaskReadinessRequest } from '../readiness-services.js';
import { useCurrentOnboardingSnapshot } from '../../../application/contracts/onboarding/onboarding-authority.js';

interface TaskReadinessOwner {
  readonly snapshot: TaskSubmissionReadinessSnapshot | undefined;
  readonly refresh: () => void;
  readonly openWorkspacePicker: (() => void) | undefined;
}

// Module-local: nothing outside this file can read the snapshot.
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
    () => recoverySessionId ? () => openSessionWorkspaceRecovery(recoverySessionId) : addProject,
    [recoverySessionId, openSessionWorkspaceRecovery, addProject],
  );
  const owner = useMemo<TaskReadinessOwner>(
    () => ({ snapshot, refresh, openWorkspacePicker }),
    [snapshot, refresh, openWorkspacePicker],
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
 * The notice's only reader. Runtime and workspace blockers render through
 * `surface`; a workspace blocker opens the picker, every other action reads
 * readiness again.
 */
export function TaskReadinessNoticeConsumer(props: { readonly surface: ComponentType<TaskReadinessNoticeView> }) {
  const locale = useUiLocale();
  const owner = useContext(TaskReadinessContext);
  if (!owner) throw new Error('TaskReadinessProvider is required');
  const notice = deriveTaskReadinessNotice(owner.snapshot, locale);
  if (!notice) return null;
  return createElement(props.surface, {
    status: notice.tone === 'destructive' ? 'error' : 'warning',
    title: notice.title,
    description: notice.description,
    actionLabel: notice.actionLabel,
    onAction: notice.action === 'workspace_picker' ? owner.openWorkspacePicker : owner.refresh,
  });
}
