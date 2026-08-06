import { createHash } from 'node:crypto';
import { normalizeMessageContent, type MessageContent } from '@maka/core/events';

export function messageContentDigest(content: MessageContent): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(normalizeMessageContent(content))))
    .digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
