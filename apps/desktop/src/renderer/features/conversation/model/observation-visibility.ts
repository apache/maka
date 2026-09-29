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
  readonly sessionId?: string;
  readonly profileId?: string;
  readonly generation: number;
}

export const INITIAL_OBSERVATION_AUTHORITY = Object.freeze<ObservationAuthority>({
  generation: 0,
});

export function reconcileObservationAuthority(
  current: ObservationAuthority,
  next: { readonly sessionId?: string; readonly profileId?: string },
): ObservationAuthority {
  if (current.sessionId !== next.sessionId) {
    return { ...next, generation: current.generation + 1 };
  }
  if (!next.profileId || next.profileId === current.profileId) return current;
  if (!current.profileId) return { ...current, profileId: next.profileId };
  return { ...next, generation: current.generation + 1 };
}

export interface LiveContentSeedState {
  readonly sessionId?: string;
  readonly generation: number;
  readonly revealed: boolean;
}

export type LiveContentSeedToken = Readonly<Required<Pick<LiveContentSeedState, 'sessionId' | 'generation'>>>;

export const INITIAL_LIVE_CONTENT_SEED = Object.freeze<LiveContentSeedState>({
  generation: 0,
  revealed: false,
});

export function beginLiveContentSeed(
  current: LiveContentSeedState,
  nextSessionId: string,
): { readonly state: LiveContentSeedState; readonly token: LiveContentSeedToken } {
  const generation = current.generation + 1;
  return {
    state: { sessionId: nextSessionId, generation, revealed: false },
    token: { sessionId: nextSessionId, generation },
  };
}

export const ownsLiveContentSeed = (
  current: LiveContentSeedState,
  token: LiveContentSeedToken,
): boolean => current.sessionId === token.sessionId && current.generation === token.generation;

export function revealLiveContentSeed(
  current: LiveContentSeedState,
  token: LiveContentSeedToken,
): LiveContentSeedState {
  return ownsLiveContentSeed(current, token) && !current.revealed
    ? { ...current, revealed: true }
    : current;
}

export const visibleLiveContentGeneration = (
  current: LiveContentSeedState,
  selectedSessionId?: string,
): number =>
  current.revealed && current.sessionId === selectedSessionId ? current.generation : 0;
