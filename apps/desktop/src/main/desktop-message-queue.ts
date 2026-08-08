import type { MessageContent, SessionEvent } from '@maka/core';

export interface DesktopQueuedTurnResult {
  ok: boolean;
}

export function startDesktopMessageQueueChain(input: {
  initialTurnId: string;
  initialEvents: AsyncIterable<SessionEvent>;
  streamTurn(turnId: string, events: AsyncIterable<SessionEvent>): Promise<DesktopQueuedTurnResult>;
  takeFollowup(): MessageContent | null;
  newTurnId(): string;
  startFollowup(turnId: string, content: MessageContent): AsyncIterable<SessionEvent>;
  onError?(error: unknown): void;
}): void {
  const first = input.streamTurn(input.initialTurnId, input.initialEvents);
  void (async () => {
    let result = await first;
    while (result.ok) {
      const followup = input.takeFollowup();
      if (!followup) return;
      const turnId = input.newTurnId();
      result = await input.streamTurn(turnId, input.startFollowup(turnId, followup));
    }
  })().catch((error) => input.onError?.(error));
}
