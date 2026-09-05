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

export interface LiveContentSeed {
  readonly sessionId: string | undefined;
  readonly generation: number;
  readonly readyGeneration: number;
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

export const EMPTY_LIVE_CONTENT_SEED: LiveContentSeed = {
  sessionId: undefined,
  generation: 0,
  readyGeneration: 0,
};

export function beginLiveContentSeed(
  current: LiveContentSeed,
  sessionId: string,
): LiveContentSeed {
  return {
    sessionId,
    generation: current.generation + 1,
    readyGeneration: 0,
  };
}

export function completeLiveContentSeed(
  current: LiveContentSeed,
  sessionId: string,
  generation: number,
): LiveContentSeed {
  if (current.sessionId !== sessionId || current.generation !== generation) {
    return current;
  }
  return {
    sessionId,
    generation,
    readyGeneration: generation,
  };
}

export function liveContentSeedRevision(
  seed: LiveContentSeed,
  activeSessionId: string | undefined,
): number {
  if (
    !activeSessionId
    || seed.sessionId !== activeSessionId
    || seed.generation === 0
    || seed.readyGeneration !== seed.generation
  ) {
    return 0;
  }
  return seed.generation;
}
