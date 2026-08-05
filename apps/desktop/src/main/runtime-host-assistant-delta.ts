import type { SessionAssistantDelta } from '@maka/runtime-host/protocol';

export interface RuntimeHostAssistantDeltaFold {
  readonly text: string;
  readonly tail: string;
}

export function foldRuntimeHostAssistantDelta(
  current: string,
  delta: Pick<SessionAssistantDelta, 'startOffset' | 'text'>,
): RuntimeHostAssistantDeltaFold {
  if (delta.startOffset > current.length) {
    throw new Error('Runtime Host assistant delta has a gap');
  }
  const overlapLength = Math.min(current.length - delta.startOffset, delta.text.length);
  if (
    overlapLength > 0 &&
    current.slice(delta.startOffset, delta.startOffset + overlapLength) !==
      delta.text.slice(0, overlapLength)
  ) {
    throw new Error('Runtime Host assistant delta conflicts with prior output');
  }
  const tail = delta.text.slice(overlapLength);
  return { text: current + tail, tail };
}
