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

import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import type {
  WorkHubCoordinationHostSessionCreator,
  WorkHubDesktopSessionBridge,
} from './workhub-session-port.js';

export interface WorkHubCoordinationHostAuthority {
  readonly sessionId: string | undefined;
  /** Revokes every operation held by a controller from an older Host generation. */
  readonly isCurrent: () => boolean;
}

/** Restricts the transitional WorkHub router to the Coordination Session's Host. */
export function scopeWorkHubSessionsToCoordinationHost(
  sessions: WorkHubDesktopSessionBridge,
  coordination: WorkHubCoordinationHostAuthority,
  createOnCoordinationHost: WorkHubCoordinationHostSessionCreator,
): WorkHubDesktopSessionBridge {
  const coordinationSessionId = coordination.sessionId;
  const hostId = (() => {
    if (!coordinationSessionId) return undefined;
    try {
      return parseDesktopSessionKey(coordinationSessionId).hostId;
    } catch {
      return undefined;
    }
  })();
  const belongsToHost = (sessionId: string, expectedHostId: string): boolean => {
    try {
      return parseDesktopSessionKey(sessionId).hostId === expectedHostId;
    } catch {
      return false;
    }
  };
  const requireHost = (): string => {
    if (!coordination.isCurrent()) throw new Error('WorkHub Coordination Session scope is revoked');
    if (!hostId) throw new Error('WorkHub Coordination Session is unresolved');
    return hostId;
  };
  const requireTargetHost = (sessionId: string): void => {
    if (!belongsToHost(sessionId, requireHost())) {
      throw new Error('WorkHub target belongs to another Runtime Host');
    }
  };
  const scoped = {
    async list() {
      if (!coordination.isCurrent()) return [];
      const expectedHostId = hostId;
      if (!expectedHostId) return [];
      return (await sessions.list()).filter((session) =>
        belongsToHost(session.id, expectedHostId),
      );
    },
    async listTurns(sessionId: string) {
      requireTargetHost(sessionId);
      return await sessions.listTurns(sessionId);
    },
    async create(input: { name: string }) {
      requireHost();
      return await createOnCoordinationHost(coordinationSessionId!, input);
    },
    async send(sessionId: string, command: { type: 'send'; turnId: string; text: string }) {
      requireTargetHost(sessionId);
      return await sessions.send(sessionId, command);
    },
    async stop(
      sessionId: string,
      input?: { source?: 'stop_button'; expectedTurnId?: string },
    ) {
      requireTargetHost(sessionId);
      await sessions.stop(sessionId, input);
    },
    subscribeChanges: (handler: () => void) => sessions.subscribeChanges(handler),
  } satisfies WorkHubDesktopSessionBridge;
  const listWithCoverage = sessions.listWithCoverage;
  if (!listWithCoverage) return scoped;
  return {
    ...scoped,
    async listWithCoverage() {
      if (!coordination.isCurrent()) return { sessions: [], completeHostIds: [] };
      const expectedHostId = hostId;
      if (!expectedHostId) return { sessions: [], completeHostIds: [] };
      const snapshot = await listWithCoverage();
      return {
        sessions: snapshot.sessions.filter((session) =>
          belongsToHost(session.id, expectedHostId),
        ),
        completeHostIds: snapshot.completeHostIds.includes(expectedHostId)
          ? [expectedHostId]
          : [],
      };
    },
  };
}
