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
import type { SharedSessionCatalogProjection } from '@maka/runtime-host/protocol';

export interface DesktopSharedSessionSummary extends SessionCatalogSummary {
  readonly labelsTruncated: false;
  readonly revision: number;
  readonly shared: true;
}

export function projectDesktopSharedSessionSummary(
  session: SharedSessionCatalogProjection,
): DesktopSharedSessionSummary {
  return {
    id: session.id,
    revision: session.revision,
    name: session.name,
    activityAt: session.activityAt,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    ...(session.lastMessageAt === undefined ? {} : { lastMessageAt: session.lastMessageAt }),
    ...(session.lastMessagePreview === undefined
      ? {}
      : { lastMessagePreview: session.lastMessagePreview }),
    status: session.status,
    ...(session.liveRunState === undefined
      ? {}
      : { runningTurnIds: [...session.liveRunState.runningTurnIds] }),
    ...(session.blockedReason === undefined ? {} : { blockedReason: session.blockedReason }),
    ...(session.statusUpdatedAt === undefined
      ? {}
      : { statusUpdatedAt: session.statusUpdatedAt }),
    backend: 'ai-sdk',
    llmConnectionSlug: '',
    connectionLocked: true,
    model: '',
    permissionMode: 'ask',
    shared: true,
  };
}
