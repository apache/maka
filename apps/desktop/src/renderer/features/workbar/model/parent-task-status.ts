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

import type { TurnStatus } from '@maka/core/session';
import type {
  HostPendingInteractionKind,
  SessionExecutionProjection,
} from '../../../application/contracts/session-execution.js';
import type { SessionWorkbarPanelsState } from './workbar-tabs.js';

/**
 * The only Session whose parent status is worth a Host read: the Side
 * Conversation the reader can actually see. It mirrors the Surface's own
 * projection, active tab and collapsed state, so a hidden Workbar, a collapsed
 * placement, an open launcher, an inactive tab, a Side Conversation of another
 * Session, or a tab the projection dropped never triggers a read.
 */
export function visibleSideChatParentSessionId(
  visiblePanels: SessionWorkbarPanelsState,
  visibility: { hidden: boolean; rightCollapsed: boolean; bottomOpen: boolean },
  sourceSessionId: string | undefined,
): string | undefined {
  if (visibility.hidden || !sourceSessionId) return undefined;
  const showing = (['right', 'bottom'] as const).some((placement) => {
    const panel = visiblePanels[placement];
    const panelVisible =
      placement === 'right' ? !visibility.rightCollapsed : visibility.bottomOpen;
    if (!panelVisible || panel.launcherOpen) return false;
    return panel.tabs.find((tab) => tab.id === panel.activeTabId)?.kind === 'side-chat';
  });
  return showing ? sourceSessionId : undefined;
}

export type {
  HostPendingInteractionKind,
  SessionExecutionProjection,
} from '../../../application/contracts/session-execution.js';

export type ParentTaskStatusKind =
  | 'unavailable'
  | 'waiting_input'
  | 'waiting_approval'
  | 'waiting_input_and_approval'
  | 'running'
  | 'last_turn_completed'
  | 'last_turn_failed'
  | 'last_turn_interrupted'
  | 'idle';

export type ParentTaskLatestTurnRead =
  | { readonly status: 'pending' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly turn: { readonly status: TurnStatus } | null };

export function classifyPendingInteractionKind(
  kind: HostPendingInteractionKind,
): 'input' | 'approval' {
  switch (kind) {
    case 'question':
    case 'form':
      return 'input';
    case 'permission':
    case 'sandbox_boundary':
    case 'client_capability':
      return 'approval';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function hostExecutionProjection(
  available: boolean,
  rootTurn: SessionExecutionProjection['rootTurn'],
  pendingInteractionKinds: readonly HostPendingInteractionKind[] = [],
): SessionExecutionProjection {
  return {
    type: 'host_execution',
    available,
    rootTurn,
    pendingInteractionKinds,
  };
}

/**
 * `null` means there is nothing honest to say yet: no projection has arrived,
 * or the projection needs a history read that has not answered. A projection
 * that reports itself unavailable is the only "unavailable" case, so an
 * initial load can never flash a warning.
 */
export function parentTaskStatusFromFacts(input: {
  readonly execution: SessionExecutionProjection | undefined;
  readonly latestTurnRead: ParentTaskLatestTurnRead;
}): ParentTaskStatusKind | null {
  const execution = input.execution;
  if (!execution || execution.observationPending) return null;
  if (!execution.available) return 'unavailable';

  let hasInput = false;
  let hasApproval = false;
  for (const kind of execution.pendingInteractionKinds) {
    if (classifyPendingInteractionKind(kind) === 'input') hasInput = true;
    else hasApproval = true;
  }
  if (hasInput && hasApproval) return 'waiting_input_and_approval';
  if (hasInput) return 'waiting_input';
  if (hasApproval) return 'waiting_approval';

  const root = execution.rootTurn;
  if (root) {
    if (root.status === 'completed') return 'last_turn_completed';
    if (root.status === 'failed') return 'last_turn_failed';
    if (root.status === 'cancelled') return 'last_turn_interrupted';
    return 'running';
  }

  const latest = input.latestTurnRead;
  if (latest.status === 'pending') return null;
  if (latest.status === 'failed') return 'unavailable';
  if (!latest.turn) return 'idle';
  if (latest.turn.status === 'completed') return 'last_turn_completed';
  if (latest.turn.status === 'failed') return 'last_turn_failed';
  if (latest.turn.status === 'aborted') return 'last_turn_interrupted';
  if (latest.turn.status === 'running') return 'unavailable';
  const exhaustive: never = latest.turn.status;
  return exhaustive;
}

export type VisibleParentTaskStatus = Exclude<ParentTaskStatusKind, 'idle'>;

export function visibleParentTaskStatus(
  kind: ParentTaskStatusKind | null,
): VisibleParentTaskStatus | null {
  return kind === 'idle' ? null : kind;
}
