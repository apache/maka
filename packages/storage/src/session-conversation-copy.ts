import type { SessionHeader } from '@maka/core/session';

export function isDiscardableConversationCopy(header: SessionHeader): boolean {
  const copy = header.conversationCopy;
  return (
    copy?.state === 'preparing' ||
    (copy?.kind === 'revision' &&
      copy.state === 'committed' &&
      header.revisionState === 'preparing')
  );
}

export function isValidConversationCopyTransition(
  current: SessionHeader,
  next: SessionHeader['conversationCopy'],
): boolean {
  const previous = current.conversationCopy;
  return (
    previous !== undefined &&
    next !== undefined &&
    previous.kind === next.kind &&
    previous.sourceSessionId === next.sourceSessionId &&
    previous.sourceTurnId === next.sourceTurnId &&
    previous.requestFingerprint === next.requestFingerprint &&
    (previous.state !== 'committed' || next.state === 'committed') &&
    (previous.state !== 'preparing' || next.state === 'preparing' || next.state === 'committed')
  );
}
