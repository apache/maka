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

import type { AgentGraphClientSnapshot } from '@maka/runtime/stream-graph-read-model';

type AgentGraphPanelStatus = AgentGraphClientSnapshot['status'];
type AgentGraphPanelDismissals = Readonly<Record<string, string>>;

interface AgentGraphPanelModelState {
  readonly rootSessionId: string;
  readonly selectedGraphId: string | undefined;
  readonly followCurrent: boolean;
  readonly collapsed: boolean | undefined;
  readonly dismissedBySession: AgentGraphPanelDismissals;
}

type AgentGraphPanelSnapshot = Pick<AgentGraphClientSnapshot, 'rootSessionId' | 'graphId' | 'status'>;

type AgentGraphPanelModelAction =
  | { type: 'enter-session'; rootSessionId: string }
  | { type: 'select-epoch'; graphId: string; current: boolean }
  | { type: 'follow-current' }
  | { type: 'commit-snapshot'; snapshot: AgentGraphPanelSnapshot; current: boolean }
  | { type: 'dismiss'; graphId: string }
  | { type: 'toggle-collapse' };

const DISMISSIBLE_STATUSES = new Set<AgentGraphPanelStatus>(['completed', 'stopped', 'failed']);
const LIVE_STATUSES = new Set<AgentGraphPanelStatus>(['active', 'waiting', 'closing']);

export function createAgentGraphPanelModel(rootSessionId: string): AgentGraphPanelModelState {
  return {
    rootSessionId,
    selectedGraphId: undefined,
    followCurrent: true,
    collapsed: undefined,
    dismissedBySession: {},
  };
}

export function reduceAgentGraphPanelModel(
  state: AgentGraphPanelModelState,
  action: AgentGraphPanelModelAction,
): AgentGraphPanelModelState {
  switch (action.type) {
    case 'enter-session':
      if (state.rootSessionId === action.rootSessionId) return state;
      return {
        ...state,
        rootSessionId: action.rootSessionId,
        selectedGraphId: undefined,
        followCurrent: true,
        collapsed: undefined,
      };
    case 'select-epoch':
      return { ...state, selectedGraphId: action.graphId, followCurrent: action.current };
    case 'follow-current':
      return { ...state, selectedGraphId: undefined, followCurrent: true };
    case 'commit-snapshot': {
      if (action.snapshot.rootSessionId !== state.rootSessionId) return state;
      let dismissedBySession = state.dismissedBySession;
      const dismissed = dismissedBySession[state.rootSessionId];
      if (
        action.current &&
        dismissed !== undefined &&
        (dismissed !== action.snapshot.graphId || !isAgentGraphPanelDismissible(action.snapshot.status))
      ) {
        dismissedBySession = withoutSessionDismissal(dismissedBySession, state.rootSessionId);
      }
      return {
        ...state,
        selectedGraphId: action.snapshot.graphId,
        collapsed: state.collapsed ?? action.snapshot.status === 'completed',
        dismissedBySession,
      };
    }
    case 'dismiss':
      return {
        ...state,
        dismissedBySession: { ...state.dismissedBySession, [state.rootSessionId]: action.graphId },
      };
    case 'toggle-collapse':
      return { ...state, collapsed: !(state.collapsed ?? false) };
  }
}

export function isAgentGraphPanelDismissible(status: AgentGraphPanelStatus | undefined): boolean {
  return status !== undefined && DISMISSIBLE_STATUSES.has(status);
}

export function isAgentGraphLive(status: AgentGraphPanelStatus | undefined): boolean {
  return status !== undefined && LIVE_STATUSES.has(status);
}

export function dismissAgentGraphPanel(
  dismissedBySession: AgentGraphPanelDismissals,
  sessionId: string,
  graphId: string,
): AgentGraphPanelDismissals {
  if (dismissedBySession[sessionId] === graphId) return dismissedBySession;
  return { ...dismissedBySession, [sessionId]: graphId };
}

export function reconcileAgentGraphPanelDismissals(
  dismissedBySession: AgentGraphPanelDismissals,
  sessionId: string,
  snapshot: { rootSessionId: string; graphId: string; status: AgentGraphPanelStatus } | undefined,
): AgentGraphPanelDismissals {
  const dismissed = dismissedBySession[sessionId];
  if (!dismissed || !snapshot || snapshot.rootSessionId !== sessionId) return dismissedBySession;
  if (snapshot.graphId === dismissed && isAgentGraphPanelDismissible(snapshot.status)) return dismissedBySession;
  return withoutSessionDismissal(dismissedBySession, sessionId);
}

export function shouldShowAgentGraphPanel(input: {
  enabled: boolean;
  hasGraphActivity: boolean;
  sessionId: string;
  graphId?: string;
  status?: AgentGraphPanelStatus;
  dismissedBySession: AgentGraphPanelDismissals;
}): boolean {
  if (
    input.graphId !== undefined &&
    input.dismissedBySession[input.sessionId] === input.graphId &&
    isAgentGraphPanelDismissible(input.status)
  ) {
    return false;
  }
  return input.enabled || input.hasGraphActivity;
}

function withoutSessionDismissal(
  dismissedBySession: AgentGraphPanelDismissals,
  sessionId: string,
): AgentGraphPanelDismissals {
  const next = { ...dismissedBySession };
  delete next[sessionId];
  return next;
}
