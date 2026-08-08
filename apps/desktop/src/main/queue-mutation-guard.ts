import type { MessageQueueMutation } from '@maka/core';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeQueueMutationInput(value: unknown): {
  expectedQueueRevision?: number;
  mutation: MessageQueueMutation;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid queue mutation');
  }
  const record = value as Record<string, unknown>;
  const expectedQueueRevision = record.expectedQueueRevision;
  if (
    expectedQueueRevision !== undefined &&
    (!Number.isSafeInteger(expectedQueueRevision) || (expectedQueueRevision as number) < 0)
  ) {
    throw new Error('Invalid queue revision');
  }
  const mutation = normalizeMutation(record.mutation);
  return {
    ...(expectedQueueRevision !== undefined
      ? { expectedQueueRevision: expectedQueueRevision as number }
      : {}),
    mutation,
  };
}

function normalizeMutation(value: unknown): MessageQueueMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid queue mutation');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'update') {
    const entryId = queueEntryId(record.entryId);
    if (typeof record.text !== 'string') {
      throw new Error('Invalid queued message content');
    }
    const text = record.text.trim();
    if (text.length === 0 || text.length > 128_000) {
      throw new Error('Invalid queued message content');
    }
    return { kind: 'update', entryId, text };
  }
  if (record.kind === 'remove' || record.kind === 'promote') {
    return { kind: record.kind, entryId: queueEntryId(record.entryId) };
  }
  if (record.kind === 'resume') return { kind: 'resume' };
  if (record.kind === 'reorder') {
    if (record.placement !== 'current_turn' && record.placement !== 'next_turn') {
      throw new Error('Invalid queue placement');
    }
    if (!Array.isArray(record.entryIds) || record.entryIds.length > 64) {
      throw new Error('Invalid queue order');
    }
    const entryIds = record.entryIds.map(queueEntryId);
    if (new Set(entryIds).size !== entryIds.length) {
      throw new Error('Invalid queue order');
    }
    return { kind: 'reorder', placement: record.placement, entryIds };
  }
  throw new Error('Invalid queue mutation');
}

function queueEntryId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error('Invalid queue entry identity');
  }
  return value;
}
