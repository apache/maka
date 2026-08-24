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
