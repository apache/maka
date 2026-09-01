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

import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import {
  useUiLocale,
  type SessionHistoryGroup,
  type SessionRailRowSelection,
  type SessionRailSelection,
} from '@maka/ui';
import { useExternalStoreSelector } from '../../../use-external-store-selector.js';
import { deriveSessionNavigationGroups } from '../model/session-navigation-groups.js';
import { deriveWorktreeSessionIds } from '../model/session-project-grouping.js';
import type { SessionRailProjection } from '../model/session-rail.js';
import {
  selectRailLayout,
  sessionRailLayoutStore,
  type SessionRailLayoutState,
} from '../model/session-rail-layout-store.js';
import type { SessionNavigationSession } from '../ports.js';
import { useSessionNavigationServices } from '../services-context.js';
import {
  createSessionNavigationRowActions,
  type SessionNavigationRowActions,
} from './session-row-actions.js';
import { useSessionSelection } from './use-session-selection.js';

export type SessionNavigationToastApi = {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
  confirm(options: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

type RefBox<T> = { current: T };

/**
 * What the rail asks of the rest of the shell, named one by one.
 *
 * Switching a session also clears the active messages and leaves the Work Hub.
 * Those are commands the shell issues, and they stay commands: the rail calls
 * them, it does not subscribe to them. Nothing here has to be identity-stable —
 * the controller reads them through a ref published on commit — so the shell
 * may build this object inline, and no ordinary `function` declaration upstream
 * can quietly put the rail back on every AppShell render (#4109).
 */
export interface SessionNavigationPorts {
  activeIdRef: RefBox<string | undefined>;
  sessionsRef: RefBox<ReadonlyArray<SessionSummary>>;
  pendingSessionRowActionsRef: RefBox<Set<string>>;
  activateSession(sessionId: string | undefined): void;
  clearActiveMessages(): void;
  clearSessionRendererState(sessionId: string): void;
  refreshSessions(): Promise<ReadonlyArray<SessionSummary>>;
  toastApi: SessionNavigationToastApi;
}

export interface UseSessionNavigationControllerInput {
  /**
   * The rail projection, derived once by its owner. The command palette lists
   * the same visible sessions, so deriving it here as well would be two
   * derivations of one reading.
   */
  rail: SessionRailProjection<SessionNavigationSession>;
  projects: readonly ProjectRecord[];
  ports: SessionNavigationPorts;
}

export interface SessionNavigationSelectors {
  groups: SessionHistoryGroup[];
  worktreeSessionIds: ReadonlySet<string>;
  sessionMeta(session: SessionSummary): string | undefined;
}

export interface SessionNavigationController {
  layout: SessionRailLayoutState;
  selectors: SessionNavigationSelectors;
  commands: SessionNavigationRowActions;
  selection: SessionRailSelection;
  /** The narrow half every row subscribes to; see `useSessionSelection`. */
  rowSelection: SessionRailRowSelection;
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

  // One subscription, not one per field: every field here is read, so a split
  // would buy no granularity, and the store replaces its state only when a
  // field actually moved — the identity IS the comparison.
  const layout = useExternalStoreSelector(sessionRailLayoutStore, selectRailLayout);

  // The ports are commands, so their identity is not information. Published on
  // commit and called through the ref, they can carry whatever the shell
  // rebuilt this render without the rail hearing about it — which is what lets
  // the row actions below be built once, per locale, instead of per render.
  //
  // This is one indirection in one place, and it replaces the alternative the
  // shell was drifting towards: hand-stabilising every function that happens to
  // be upstream of the rail, where a single ordinary `function` declaration
  // anywhere in the chain silently undoes the whole thing (#4109).
  const portsRef = useRef(ports);
  useLayoutEffect(() => {
    portsRef.current = ports;
  });

  const commands = useMemo(
    () =>
      createSessionNavigationRowActions({
        uiLocale: locale,
        activeIdRef: portsRef.current.activeIdRef,
        clearActiveMessages: () => portsRef.current.clearActiveMessages(),
        clearSessionRendererState: (sessionId) =>
          portsRef.current.clearSessionRendererState(sessionId),
        pendingSessionRowActionsRef: portsRef.current.pendingSessionRowActionsRef,
        refreshSessions: () => portsRef.current.refreshSessions(),
        service,
        sessionsRef: portsRef.current.sessionsRef,
        setActiveId: (sessionId) => portsRef.current.activateSession(sessionId),
        toastApi: {
          success: (title, description) => portsRef.current.toastApi.success(title, description),
          error: (title, description, details, target) =>
            portsRef.current.toastApi.error(title, description, details, target),
          confirm: (options) => portsRef.current.toastApi.confirm(options),
        },
      }),
    [locale, service],
  );

  const groups = useMemo(
    () => deriveSessionNavigationGroups(rail.sessions, input.projects, locale),
    [locale, input.projects, rail.sessions],
  );
  const worktreeSessionIds = useMemo(
    () =>
      deriveWorktreeSessionIds(
        rail.sessions.filter(
          (session) => !runtimeHostProfileUsesHostWorkspace(session.profileKind),
        ),
        input.projects,
      ),
    [input.projects, rail.sessions],
  );
  const sessionById = useMemo(
    () => new Map(rail.sessions.map((session) => [session.id, session])),
    [rail.sessions],
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
    () => ({ groups, worktreeSessionIds, sessionMeta }),
    [groups, sessionMeta, worktreeSessionIds],
  );

  const { selection, rowSelection } = useSessionSelection({ sessions: rail.sessions, commands });

  return useMemo(
    () => ({ layout, selectors, commands, selection, rowSelection }),
    [commands, layout, rowSelection, selection, selectors],
  );
}
