import type { FollowUpMode } from '@maka/core';

export function hasActiveTurnAtSubmit(input: {
  liveTurn?: { turnId: string; terminal?: boolean };
  runningTurnIds?: readonly string[];
}): boolean {
  if (input.liveTurn?.terminal !== true && input.liveTurn !== undefined) return true;
  return input.runningTurnIds?.some((turnId) => turnId !== input.liveTurn?.turnId) === true;
}

export function resolveFollowUpModeAtSubmit(input: {
  requestedMode?: FollowUpMode;
  defaultMode: FollowUpMode;
  hasActiveTurn: boolean;
}): FollowUpMode | undefined {
  if (input.requestedMode) return input.requestedMode;
  return input.hasActiveTurn ? input.defaultMode : undefined;
}
