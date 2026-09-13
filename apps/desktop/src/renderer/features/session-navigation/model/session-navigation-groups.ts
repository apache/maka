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

import type { ProjectRecord } from '@maka/core/project';
import type { UiLocale } from '@maka/core/ui-locale';
import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import type { SessionHistoryGroup } from '@maka/ui';
import type { SessionNavigationSession } from '../ports.js';
import { deriveProjectGroups } from './session-project-grouping.js';

/** Groups native-local Sessions by Project and other Sessions by Runtime Host. */
export function deriveSessionNavigationGroups(
  sessions: readonly SessionNavigationSession[],
  projects: readonly ProjectRecord[],
  locale: UiLocale,
): SessionHistoryGroup[] {
  const local: SessionNavigationSession[] = [];
  const hosts = new Map<
    string,
    { label: string; sessions: SessionNavigationSession[] }
  >();
  for (const session of sessions) {
    if (!runtimeHostProfileUsesHostWorkspace(session.profileKind)) {
      local.push(session);
      continue;
    }
    const group = hosts.get(session.profileId) ?? {
      label: session.profileName,
      sessions: [],
    };
    group.sessions.push(session);
    hosts.set(session.profileId, group);
  }
  return [
    ...deriveProjectGroups(local, projects, locale),
    ...[...hosts].map(([id, group]) => ({
      id: `runtime-host:${id}`,
      label: group.label,
      sessions: group.sessions,
    })),
  ];
}
