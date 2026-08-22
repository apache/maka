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

export type AgentGraphPanelStatus =
  | 'empty'
  | 'active'
  | 'closing'
  | 'waiting'
  | 'stopped'
  | 'failed'
  | 'completed';

export type AgentGraphPanelDismissals = Readonly<Record<string, string>>;

const DISMISSIBLE_STATUSES = new Set<AgentGraphPanelStatus>([
  'completed',
  'stopped',
  'failed',
]);

export function isAgentGraphPanelDismissible(
  status: AgentGraphPanelStatus | undefined,
): boolean {
  return status !== undefined && DISMISSIBLE_STATUSES.has(status);
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
  snapshot:
    | { rootSessionId: string; graphId: string; status: AgentGraphPanelStatus }
    | undefined,
): AgentGraphPanelDismissals {
  const dismissed = dismissedBySession[sessionId];
  if (!dismissed || !snapshot || snapshot.rootSessionId !== sessionId) {
    return dismissedBySession;
  }
  if (snapshot.graphId === dismissed && isAgentGraphPanelDismissible(snapshot.status)) {
    return dismissedBySession;
  }
  const next = { ...dismissedBySession };
  delete next[sessionId];
  return next;
}

export function shouldShowAgentGraphPanel(input: {
  enabled: boolean;
  hasGraphActivity: boolean;
  error: boolean;
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
  return input.enabled || input.hasGraphActivity || input.error;
}
