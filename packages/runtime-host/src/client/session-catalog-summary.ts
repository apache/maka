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

import type { SessionCatalogSummary } from '@maka/core/session';
import type { SessionCatalogProjection } from '../protocol/session-catalog.js';

export function projectSessionCatalogSummary(
  session: SessionCatalogProjection,
): SessionCatalogSummary {
  return {
    id: session.id,
    cwd: session.workspace.hostCwd,
    ...(session.workspace.target.kind === 'project'
      ? { projectId: session.workspace.target.projectId }
      : {}),
    activityAt: session.activityAt,
    name: session.name,
    isFlagged: session.isFlagged,
    isArchived: session.isArchived,
    labels: [...session.labels],
    hasUnread: session.hasUnread,
    ...(session.lastMessageAt === undefined ? {} : { lastMessageAt: session.lastMessageAt }),
    ...(session.lastMessagePreview === undefined
      ? {}
      : { lastMessagePreview: session.lastMessagePreview }),
    status: session.status,
    ...(session.blockedReason === undefined ? {} : { blockedReason: session.blockedReason }),
    ...(session.statusUpdatedAt === undefined ? {} : { statusUpdatedAt: session.statusUpdatedAt }),
    ...(session.liveRunState === undefined
      ? {}
      : { runningTurnIds: [...session.liveRunState.runningTurnIds] }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.branchOfTurnId === undefined ? {} : { branchOfTurnId: session.branchOfTurnId }),
    ...(session.subagent === undefined ? {} : { subagent: session.subagent }),
    ...(session.revisionRootSessionId === undefined
      ? {}
      : { revisionRootSessionId: session.revisionRootSessionId }),
    ...(session.revisionParentSessionId === undefined
      ? {}
      : { revisionParentSessionId: session.revisionParentSessionId }),
    ...(session.revisionOfTurnId === undefined
      ? {}
      : { revisionOfTurnId: session.revisionOfTurnId }),
    ...(session.revisionIndex === undefined ? {} : { revisionIndex: session.revisionIndex }),
    ...(session.revisionState === undefined ? {} : { revisionState: session.revisionState }),
    backend: session.backend,
    ...(session.llmConnectionId === null ? {} : { llmConnectionId: session.llmConnectionId }),
    llmConnectionSlug: session.llmConnectionSlug,
    connectionLocked: session.connectionLocked,
    model: session.model,
    ...(session.thinkingLevel === undefined ? {} : { thinkingLevel: session.thinkingLevel }),
    permissionMode: session.permissionMode,
    collaborationMode: session.collaborationMode,
    orchestrationMode: session.orchestrationMode,
  };
}
