import type { RuntimeEvent } from '@maka/core/runtime-event';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isRuntimeStorageSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

export function immutableSteeringMessageId(event: RuntimeEvent): string | undefined {
  const messageId = event.refs?.providerEventId;
  return event.partial === false &&
    typeof messageId === 'string' &&
    isRuntimeStorageSafeId(messageId) &&
    event.content?.kind === 'text' &&
    event.content.steering === true
    ? messageId
    : undefined;
}
