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

import type { SessionChangedEvent, SessionSummary } from '@maka/core/session';
import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import { recordSessionEventStreamChange } from './session-event-health.js';

type RefBox<T> = { current: T };

type SessionEventHealthUpdater = (
  updater: (current: Record<string, SessionEventStreamSnapshot>) => Record<string, SessionEventStreamSnapshot>,
) => void;

export function handleSessionChangedEvent(
  event: SessionChangedEvent,
  options: {
    activeIdRef: RefBox<string | undefined>;
    clearPendingTurnActionsForSession: (sessionId: string) => void;
    refreshMessages: (sessionId: string) => Promise<boolean>;
    refreshProjects: () => Promise<unknown>;
    refreshSessions: () => Promise<SessionSummary[]>;
    refreshChangedSession: (sessionId: string) => Promise<SessionSummary | null>;
    retireSession: (sessionId: string) => void;
    retiredSessionIds(sessions: readonly { id: string }[]): string[];
    /** A targeted row read committed this id's authoritative absence. */
    isSessionRemoved(sessionId: string): boolean;
    /** Mirrors the committed catalog; refresh promises resolve after commit. */
    sessionsRef: RefBox<readonly SessionSummary[]>;
    /** Surfaces a model rebound; the caller owns the copy. */
    notifyModelRebound: (modelId: string | undefined) => void;
    setSessionEventHealthBySession: SessionEventHealthUpdater;
  },
): void {
  const changedSessionId = event.sessionId;
  const refreshedSessions: Promise<unknown> = changedSessionId === undefined
    ? options.refreshSessions()
    : options.refreshChangedSession(changedSessionId);
  if (event.reason === 'archived' && event.sessionId) options.retireSession(event.sessionId);
  if (event.reason === 'created' || event.reason === 'migrated') {
    void options.refreshProjects();
  }
  if (event.sessionId) {
    options.setSessionEventHealthBySession((current) => {
      const previous = current[event.sessionId!];
      if (!previous) return current;
      return {
        ...current,
        [event.sessionId!]: recordSessionEventStreamChange(previous, event.ts),
      };
    });
  }
  if (
    event.sessionId &&
    (event.reason === 'turn-status-change' || event.reason === 'message-appended' || event.reason === 'deleted')
  ) {
    options.clearPendingTurnActionsForSession(event.sessionId);
  }
  if (event.reason === 'message-appended' && changedSessionId && changedSessionId === options.activeIdRef.current) {
    void options.refreshMessages(changedSessionId);
  }
  if (event.reason === 'rebound') options.notifyModelRebound(event.modelId);
  void refreshedSessions.then(() => {
    if (changedSessionId === undefined) {
      // A list read is the catalog's membership authority.
      options.retiredSessionIds(options.sessionsRef.current).forEach(options.retireSession);
      return;
    }
    // A row-level read can only prove its own row's absence.
    if (options.isSessionRemoved(changedSessionId)) options.retireSession(changedSessionId);
  });
}
