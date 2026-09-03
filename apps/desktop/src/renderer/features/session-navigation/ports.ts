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

import type { RefObject } from 'react';
import type { SessionSummary } from '@maka/core/session';
import type { RuntimeHostProfileKind } from '@maka/runtime-host/profile-kind';

export type SessionNavigationRemoveDisposition = 'removed' | 'restored';

/**
 * How a delete settled together with the count the Host actually archived.
 * `archivedSubtaskCount` is the Host's executed number — 0 when the delete was
 * called off (`restored`) — so the toast reports a fact, not a renderer guess.
 */
export interface SessionNavigationRemoveOutcome {
  readonly disposition: SessionNavigationRemoveDisposition;
  readonly archivedSubtaskCount: number;
}

/**
 * The slice of the shell toast surface the rail uses. Structural typing checks
 * it against the real `ToastApi` where the shell wires it in.
 */
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

export interface SessionNavigationSession extends SessionSummary {
  readonly profileId: string;
  readonly profileName: string;
  readonly profileKind: RuntimeHostProfileKind;
}

/** The minimum catalog mutation capability needed by Session Navigation. */
export interface SessionNavigationSessionService {
  list(): Promise<SessionSummary[]>;
  setFlagged(
    sessionId: string,
    flagged: boolean,
    options: { revisionFamily: true },
  ): Promise<void>;
  archive(
    sessionId: string,
    options: { revisionFamily: true },
  ): Promise<void>;
  unarchive(
    sessionId: string,
    options: { revisionFamily: true },
  ): Promise<void>;
  rename(
    sessionId: string,
    name: string,
    options: { revisionFamily: true },
  ): Promise<void>;
  remove(
    sessionId: string,
    options: { revisionFamily: true; requireArchived: boolean },
  ): Promise<SessionNavigationRemoveOutcome>;
  /**
   * How many linked subtasks a delete of this parent would move to the archive,
   * per the Host's removal plan. The delete confirm warns off this instead of
   * estimating from the catalog projection.
   */
  previewRemoval(sessionId: string): Promise<number>;
}

export interface SessionNavigationServices {
  readonly sessions: SessionNavigationSessionService;
}

/**
 * What the rail asks of the rest of the shell, named one by one.
 *
 * Switching a session also clears the active messages and leaves the Work Hub.
 * Those are commands the shell issues, and they stay commands: the rail calls
 * them, it does not subscribe to them. The function fields need no identity
 * stability — the controller reads them through a ref published on commit — so
 * the shell may rebuild this object inline, and no ordinary `function`
 * declaration upstream can quietly put the rail back on every AppShell render
 * (#4109). The ref boxes themselves must be stable (`useRef` results): row
 * actions capture them once and dereference at call time.
 */
export interface SessionNavigationPorts {
  activeIdRef: RefObject<string | undefined>;
  sessionsRef: RefObject<ReadonlyArray<SessionSummary>>;
  pendingSessionRowActionsRef: RefObject<Set<string>>;
  activateSession(sessionId: string | undefined): void;
  clearActiveMessages(): void;
  clearSessionRendererState(sessionId: string): void;
  refreshSessions(): Promise<ReadonlyArray<SessionSummary>>;
  toastApi: SessionNavigationToastApi;
}
