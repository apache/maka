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

export interface ObservationAuthority {
  readonly sessionId: string | undefined;
  readonly profileId: string | undefined;
  readonly generation: number;
}

export const INITIAL_OBSERVATION_AUTHORITY: ObservationAuthority = {
  sessionId: undefined,
  profileId: undefined,
  generation: 0,
};

export function reconcileObservationAuthority(
  current: ObservationAuthority,
  sessionId: string | undefined,
  profileId: string | undefined,
): ObservationAuthority {
  if (current.sessionId !== sessionId) {
    return { sessionId, profileId, generation: current.generation + 1 };
  }
  if (!profileId || profileId === current.profileId) return current;
  if (!current.profileId) return { ...current, profileId };
  return { sessionId, profileId, generation: current.generation + 1 };
}

export interface LiveContentSeedState {
  readonly sessionId: string | undefined;
  readonly generation: number;
  readonly revealed: boolean;
}

export interface LiveContentSeedToken {
  readonly sessionId: string;
  readonly generation: number;
}

export const INITIAL_LIVE_CONTENT_SEED: LiveContentSeedState = {
  sessionId: undefined,
  generation: 0,
  revealed: false,
};

export function beginLiveContentSeed(
  current: LiveContentSeedState,
  sessionId: string,
): { state: LiveContentSeedState; token: LiveContentSeedToken } {
  const state: LiveContentSeedState = {
    sessionId,
    generation: current.generation + 1,
    revealed: false,
  };
  return { state, token: { sessionId, generation: state.generation } };
}

export function ownsLiveContentSeed(
  current: LiveContentSeedState,
  token: LiveContentSeedToken,
): boolean {
  return current.sessionId === token.sessionId && current.generation === token.generation;
}

export function revealLiveContentSeed(
  current: LiveContentSeedState,
  token: LiveContentSeedToken,
): LiveContentSeedState {
  if (!ownsLiveContentSeed(current, token) || current.revealed) return current;
  return { ...current, revealed: true };
}

export function visibleLiveContentGeneration(
  current: LiveContentSeedState,
  activeSessionId: string | undefined,
): number {
  if (!current.revealed || current.sessionId !== activeSessionId) return 0;
  return current.generation;
}
