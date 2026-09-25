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

import type { SessionMoveTarget } from '@maka/ui';
import { projectGroupId, ungroupedGroupId } from './session-navigation-groups.js';
import type {
  SessionNavigationProjectScope,
  SessionNavigationSession,
} from '../ports.js';

/**
 * Where may this Session be moved to?
 *
 * The rail draws a row for every Host's Projects, so a task may only be moved
 * among its own Host's — and only into a project that can receive one. The
 * "leave every project" exit rides the same answer, but is only offered while
 * the Session is in a project the rail can still see. A truthy `projectId`
 * the Project scopes no longer carry — deleted, relocated, archived upstream —
 * is functionally no project, and offering the exit there drew the orphan row
 * for tasks the user already reads as project-less.
 */
export function sessionMoveTargets(
  session: SessionNavigationSession,
  projectScopes: readonly SessionNavigationProjectScope[],
): readonly SessionMoveTarget[] {
  const targets: SessionMoveTarget[] = projectScopes
    .filter(
      (scope) =>
        scope.hostId === session.runtimeHostId &&
        scope.project.available &&
        scope.project.archivedAt === undefined,
    )
    .map((scope) => ({
      groupKey: projectGroupId(scope.key),
      projectId: scope.project.id,
      name: scope.project.name,
    }));
  const isInVisibleProject =
    session.projectId !== null &&
    session.projectId !== undefined &&
    targets.some((target) => target.projectId === session.projectId);
  if (isInVisibleProject) {
    // The rail names the exit itself, so no label is given here.
    targets.push({
      groupKey: ungroupedGroupId(session.runtimeHostId),
      projectId: null,
    });
  }
  return targets;
}
