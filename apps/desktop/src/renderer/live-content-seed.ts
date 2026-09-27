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

export interface LiveContentGate {
  readonly sessionId: string | undefined;
  readonly issuedRevision: number;
  readonly visibleRevision: number;
}

export interface SessionObservationAuthority {
  readonly sessionId: string | undefined;
  readonly profileId: string | undefined;
  readonly revision: number;
}

export const EMPTY_SESSION_OBSERVATION_AUTHORITY: SessionObservationAuthority = {
  sessionId: undefined,
  profileId: undefined,
  revision: 0,
};

/**
 * Changes the observation identity only when its actual authority changes.
 *
 * A newly created Session is selected before its catalog row arrives. The
 * preload already resolved and pinned that Session's profile for the first
 * observation, so the catalog's later undefined -> profile hydration is not a
 * new authority and must not tear down the ready stream. A known profile
 * changing to another known profile is a real authority handoff and does need
 * a fresh observation.
 */
export function advanceSessionObservationAuthority(
  current: SessionObservationAuthority,
  sessionId: string | undefined,
  profileId: string | undefined,
): SessionObservationAuthority {
  if (current.sessionId !== sessionId) {
    return { sessionId, profileId, revision: current.revision + 1 };
  }
  if (profileId === undefined || profileId === current.profileId) return current;
  if (current.profileId === undefined) return { ...current, profileId };
  return { sessionId, profileId, revision: current.revision + 1 };
}

export const EMPTY_LIVE_CONTENT_GATE: LiveContentGate = {
  sessionId: undefined,
  issuedRevision: 0,
  visibleRevision: 0,
};

export function closeLiveContentGate(
  current: LiveContentGate,
  sessionId: string,
): LiveContentGate {
  return {
    sessionId,
    issuedRevision: current.issuedRevision + 1,
    visibleRevision: 0,
  };
}

export function openLiveContentGate(
  current: LiveContentGate,
  sessionId: string,
  revision: number,
): LiveContentGate {
  if (current.sessionId !== sessionId || current.issuedRevision !== revision) {
    return current;
  }
  if (current.visibleRevision === revision) return current;
  return { ...current, visibleRevision: revision };
}

export function visibleLiveContentRevision(
  gate: LiveContentGate,
  activeSessionId: string | undefined,
): number {
  if (!activeSessionId || gate.sessionId !== activeSessionId) return 0;
  return gate.visibleRevision;
}
