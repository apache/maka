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

import type { tr as translate } from './locale';
import type { ActiveWorker } from './botTranscriptCore';

export function workerLabel(worker: ActiveWorker, tr: typeof translate) {
  const { title, activity, progress } = worker;
  const kind = progress?.kind;
  const detail = progress?.detail ?? '';
  if (activity === 'waiting') {
    const status =
      kind === 'approval'
        ? tr('Waiting for approval')
        : kind === 'form'
          ? tr('Awaiting form')
          : kind === 'permission'
            ? tr('Awaiting permission')
            : tr('Awaiting reply');
    return `${title} · ${status}`;
  }
  const status = `${title} · ${tr('Worker running')}`;
  if (!detail && kind !== 'thinking' && kind !== 'generating') return status;
  let action = '';
  switch (kind) {
    case 'thinking':
      action = tr('Worker thinking');
      break;
    case 'generating':
      action = tr('Generating answer…');
      break;
    case 'command':
    case 'tool':
      action = tr('Running {detail}', { detail });
      break;
    case 'edit':
      action = tr('Editing {detail}', { detail });
      break;
    case 'read':
      action = tr('Reading {detail}', { detail });
      break;
    case 'summary':
      action = detail;
      break;
  }
  return action ? `${status} · ${action}` : status;
}

export function shownWorkers(workers: readonly ActiveWorker[], expanded: boolean) {
  return expanded ? workers : workers.slice(0, 2);
}
export function workerPulse(
  activity: ActiveWorker['activity'],
  terminal: boolean,
  reduced: boolean,
) {
  return activity === 'working' && !terminal && !reduced ? 'pulse' : 'none';
}
