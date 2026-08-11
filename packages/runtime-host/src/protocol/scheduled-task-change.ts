import { requireCount, requireEntityId, requireShapedRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';

export type ScheduledTaskChangedReason =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'fired'
  | 'failed'
  | 'blocked';

export interface ScheduledTaskChangedFrame {
  readonly kind: 'scheduled-task.changed';
  readonly revision: number;
  readonly reason: ScheduledTaskChangedReason;
  readonly taskId: string;
}

export function decodeScheduledTaskChangedFrame(value: unknown): ScheduledTaskChangedFrame {
  const frame = requireShapedRecord(
    value,
    'ScheduledTask changed frame',
    ['kind', 'revision', 'reason', 'taskId'],
    [],
  );
  if (!isReason(frame.reason)) throw invalidProtocolFrame('Invalid ScheduledTask change reason');
  return {
    kind: 'scheduled-task.changed',
    revision: requireCount(frame.revision, 'ScheduledTask change revision'),
    reason: frame.reason,
    taskId: requireEntityId(frame.taskId, 'ScheduledTask id'),
  };
}

function isReason(value: unknown): value is ScheduledTaskChangedReason {
  return (
    value === 'created' ||
    value === 'updated' ||
    value === 'deleted' ||
    value === 'fired' ||
    value === 'failed' ||
    value === 'blocked'
  );
}
