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

import { findProjectByIdentity } from '@maka/core/project';
import type { SessionMoveTarget } from '@maka/ui';
import { projectGroupId, ungroupedGroupId } from './session-navigation-groups.js';
import type {
  SessionNavigationProjectScope,
  SessionNavigationSession,
} from '../ports.js';

/**
 * Resolve membership before filtering destinations: an archived or unavailable
 * project still owns its Sessions, and historical aliases still identify it.
 * Menus and drops consume the same targets, excluding the current project and
 * offering an exit only when the owning Host still knows that project.
 */
export function sessionMoveTargets(
  session: SessionNavigationSession,
  projectScopes: readonly SessionNavigationProjectScope[],
): readonly SessionMoveTarget[] {
  const hostScopes = projectScopes.filter((scope) => scope.hostId === session.runtimeHostId);
  const currentProject = session.projectId
    ? findProjectByIdentity(hostScopes.map((scope) => scope.project), session.projectId)
    : undefined;
  const targets: SessionMoveTarget[] = hostScopes
    .filter(
      (scope) =>
        scope.project.id !== currentProject?.id &&
        scope.project.available &&
        scope.project.archivedAt === undefined,
    )
    .map((scope) => ({
      groupKey: projectGroupId(scope.key),
      projectId: scope.project.id,
      name: scope.project.name,
    }));
  if (currentProject) {
    // The rail names the exit itself, so no label is given here.
    targets.push({
      groupKey: ungroupedGroupId(session.runtimeHostId),
      projectId: null,
    });
  }
  return targets;
}
