import type { TaskInboxItem } from './task-contracts.js';

export function budgetExtensionInboxItem(input: {
  inboxItemId: string;
  taskRunId: string;
  attemptId?: string;
  reason: string;
  createdAt: number;
  budget: Record<string, unknown>;
}): TaskInboxItem {
  return {
    schemaVersion: 1,
    inboxItemId: input.inboxItemId,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    kind: 'budget_extension',
    status: 'open',
    title: 'Budget extension requested',
    reason: input.reason,
    createdAt: input.createdAt,
    preview: { budget: input.budget },
  };
}
