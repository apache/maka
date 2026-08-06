import { createHash } from 'node:crypto';
import { normalizeMessageContent, type MessageContent } from '@maka/core/events';

export function messageContentDigest(content: MessageContent): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(normalizeMessageContent(content)))
    .digest('hex')}`;
}
