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
