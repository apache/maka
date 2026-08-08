import type { StoredMessage } from '@maka/core';

/**
 * The Session store is the durable transcript authority for imports and
 * completed turns. RuntimeEvent projection may add or replace live messages,
 * but an empty Runtime ledger must not erase an imported raw transcript.
 */
export function mergeDurableAndRuntimeMessages(
  durable: readonly StoredMessage[],
  runtime: readonly StoredMessage[],
): StoredMessage[] {
  const merged = durable.map((message) => structuredClone(message));
  const indices = new Map(merged.map((message, index) => [message.id, index]));
  for (const message of runtime) {
    const index = indices.get(message.id);
    if (index === undefined) {
      indices.set(message.id, merged.length);
      merged.push(structuredClone(message));
    } else {
      merged[index] = structuredClone(message);
    }
  }
  return merged;
}
