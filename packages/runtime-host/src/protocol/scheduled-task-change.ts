/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
