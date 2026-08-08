import { createHash } from 'node:crypto';

export function taskRunLocator(taskRunId: string): string {
  if (taskRunId.length === 0) {
    throw new Error('taskRunId must not be empty');
  }
  try {
    encodeURIComponent(taskRunId);
  } catch {
    throw new Error('taskRunId must be well-formed Unicode');
  }
  return createHash('sha256').update(taskRunId, 'utf8').digest('hex');
}
