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

import { sessionRevisionFamilyId, visibleSessionRevisionMembers } from '@maka/core/session-revisions';

import { type SessionSummary } from '@maka/core/session';

export interface SessionRevisionNavigation {
  current: number;
  total: number;
  previousSessionId?: string;
  nextSessionId?: string;
}

/** Build deterministic old/new version navigation for the active conversation. */
export function deriveSessionRevisionNavigation(
  sessions: readonly SessionSummary[],
  activeId: string | undefined,
): SessionRevisionNavigation | undefined {
  if (!activeId) return undefined;
  const active = sessions.find((session) => session.id === activeId);
  if (!active) return undefined;
  const root = sessionRevisionFamilyId(active);
  const rawFamily = sessions.filter((session) => sessionRevisionFamilyId(session) === root);
  const family = visibleSessionRevisionMembers(rawFamily, activeId);
  if (family.length <= 1) return undefined;
  const ordered = [...family].sort((left, right) => {
    const indexDelta = (left.revisionIndex ?? 1) - (right.revisionIndex ?? 1);
    return indexDelta !== 0 ? indexDelta : left.id.localeCompare(right.id);
  });
  const index = ordered.findIndex((session) => session.id === activeId);
  if (index < 0) return undefined;
  return {
    current: index + 1,
    total: ordered.length,
    ...(ordered[index - 1] ? { previousSessionId: ordered[index - 1]!.id } : {}),
    ...(ordered[index + 1] ? { nextSessionId: ordered[index + 1]!.id } : {}),
  };
}
