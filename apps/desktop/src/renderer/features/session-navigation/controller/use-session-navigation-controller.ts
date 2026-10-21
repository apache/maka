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

import { useCallback, useMemo } from 'react';
import { useSessionNavigationRowActions } from './use-session-navigation-row-actions.js';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import {
  deriveTitlebarProjectName,
  useUiLocale,
  type SessionHistoryGroup,
} from '@maka/ui';
import { runtimeHostProjectKey } from '../../../application/contracts/runtime-host-project-key.js';
import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';
import { deriveSessionNavigationGroups } from '../model/session-navigation-groups.js';
import {
  deriveSessionLocation,
  deriveWorktreeSessionIds,
} from '../model/session-project-grouping.js';
import type { SessionRailProjection } from '../model/session-rail.js';
import {
  selectRailLayout,
  sessionRailLayoutStore,
  type SessionRailLayoutState,
} from '../model/session-rail-layout-store.js';
import type {
  SessionNavigationPorts,
  SessionNavigationProjectScope,
  SessionNavigationSession,
} from '../ports.js';
import { useSessionNavigationServices } from '../services-context.js';
import {
  type SessionNavigationRowActions,
} from './session-row-actions.js';

export interface UseSessionNavigationControllerInput {
  /**
   * The rail projection, derived once by its owner. The command palette lists
   * the same visible sessions, so deriving it here as well would be two
   * derivations of one reading.
   */
  rail: SessionRailProjection<SessionNavigationSession>;
  projectScopes: readonly SessionNavigationProjectScope[];
  ports: SessionNavigationPorts;
}

export interface SessionNavigationSelectors {
  groups: SessionHistoryGroup[];
  worktreeSessionIds: ReadonlySet<string>;
  sessionProjectName(session: SessionSummary): string | undefined;
  sessionLocation(session: SessionSummary): string | undefined;
  sessionMeta(session: SessionSummary): string | undefined;
}

export interface SessionNavigationController {
  layout: SessionRailLayoutState;
  selectors: SessionNavigationSelectors;
  commands: SessionNavigationRowActions;
}

/**
 * Owns the Session rail's projections, its geometry, and its row mutations.
 *
 * Called by `SessionNavigationProvider`, which sits directly above the rail.
 * It used to be called in AppShell's render body, and that one fact — not the
 * size of any file — put the rail's state above the whole tree (#4109).
 */
export function useSessionNavigationController(
  input: UseSessionNavigationControllerInput,
): SessionNavigationController {
  const locale = useUiLocale();
  const { sessions: service } = useSessionNavigationServices();
  const { ports, rail } = input;
  const layout = useExternalStoreSelector(sessionRailLayoutStore, selectRailLayout);
  const commands = useSessionNavigationRowActions(ports, service);

  const groups = useMemo(
    () =>
      deriveSessionNavigationGroups(rail.sessions, input.projectScopes, locale),
    [locale, input.projectScopes, rail.sessions],
  );
  const worktreeSessionIds = useMemo(
    () =>
      deriveWorktreeSessionIds(
        rail.sessions.filter(
          (session) => !runtimeHostProfileUsesHostWorkspace(session.profileKind),
        ),
        input.projectScopes
          .filter((scope) => scope.profileKind === 'local')
          .map((scope) => scope.project),
      ),
    [input.projectScopes, rail.sessions],
  );
  const sessionById = useMemo(
    () => new Map(rail.sessions.map((session) => [session.id, session])),
    [rail.sessions],
  );
  const projectByIdentity = useMemo(() => {
    const projects = new Map<string, ProjectRecord>();
    for (const scope of input.projectScopes) {
      projects.set(runtimeHostProjectKey(scope.hostId, scope.project.id), scope.project);
      for (const alias of scope.project.aliases ?? []) {
        projects.set(runtimeHostProjectKey(scope.hostId, alias), scope.project);
      }
    }
    return projects;
  }, [input.projectScopes]);
  const sessionProjectName = useCallback(
    (session: SessionSummary): string | undefined => {
      const projected = sessionById.get(session.id);
      return deriveTitlebarProjectName({
        projectName: projected?.projectId
          ? projectByIdentity.get(
              runtimeHostProjectKey(projected.runtimeHostId, projected.projectId),
            )?.name
          : undefined,
        projectPath: session.cwd,
      });
    },
    [projectByIdentity, sessionById],
  );
  const sessionLocation = useCallback(
    (session: SessionSummary): string | undefined => {
      const projected = sessionById.get(session.id);
      if (!projected || runtimeHostProfileUsesHostWorkspace(projected.profileKind)) {
        return undefined;
      }
      const project = projected.projectId
        ? projectByIdentity.get(
            runtimeHostProjectKey(projected.runtimeHostId, projected.projectId),
          )
        : undefined;
      return deriveSessionLocation(projected, project);
    },
    [projectByIdentity, sessionById],
  );
  const sessionMeta = useCallback(
    (session: SessionSummary): string | undefined => {
      const projected: SessionNavigationSession | undefined = sessionById.get(session.id);
      return projected && runtimeHostProfileUsesHostWorkspace(projected.profileKind)
        ? projected.profileName
        : undefined;
    },
    [sessionById],
  );

  const selectors = useMemo<SessionNavigationSelectors>(
    () => ({ groups, worktreeSessionIds, sessionProjectName, sessionLocation, sessionMeta }),
    [groups, sessionLocation, sessionMeta, sessionProjectName, worktreeSessionIds],
  );

  return useMemo(() => ({ layout, selectors, commands }), [commands, layout, selectors]);
}
