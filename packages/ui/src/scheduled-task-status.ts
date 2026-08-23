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

import type { ScheduledTaskRunOutcome, ScheduledTaskStatus } from '@maka/core/scheduled-task';
import { dotForStatus, type StatusSemantic } from './status-vocabulary.js';

/**
 * Lifecycle meaning for a task itself: paused is the only state that asks
 * for attention, completed is spent, everything else is simply live.
 *
 * Shared by the list page and the inspector so one task never reads as two
 * different severities depending on where it is shown. Says what the state
 * MEANS and lets status-vocabulary decide the colour — the domain judgement
 * (that paused deserves attention) is this file's, the palette is not.
 */
export function scheduledTaskStatusSemantic(status: ScheduledTaskStatus): StatusSemantic {
  if (status === 'paused') return 'attention';
  if (status === 'completed') return 'neutral';
  return 'active';
}

export function scheduledTaskStatusDotVariant(status: ScheduledTaskStatus) {
  return dotForStatus(scheduledTaskStatusSemantic(status));
}

/**
 * Run-history meaning. `triggered` = it fired, which is a record rather than a
 * health signal, so it reads as `active` and never earns success-green;
 * `blocked` = intentionally skipped, which asks for attention; `failed` = a
 * delivery error. Exception-only by design.
 */
export function scheduledTaskRunStatusSemantic(
  status: ScheduledTaskRunOutcome,
): StatusSemantic {
  if (status === 'blocked') return 'attention';
  if (status === 'failed') return 'error';
  return 'active';
}

export function scheduledTaskRunStatusDotVariant(status: ScheduledTaskRunOutcome) {
  return dotForStatus(scheduledTaskRunStatusSemantic(status));
}
