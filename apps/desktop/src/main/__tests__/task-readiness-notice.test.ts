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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import {
  deriveTaskReadinessNotice,
  isTaskSubmissionHardBlocked,
  resolveTaskReadinessModelTarget,
} from '../../renderer/task-readiness-notice.js';

test('an unlocked stale session checks the send projection rebind target', () => {
  assert.deepEqual(
    resolveTaskReadinessModelTarget(
      { llmConnectionSlug: 'stale', model: 'removed-model' },
      { kind: 'rebind', connectionSlug: 'healthy', model: 'ready-model' },
      undefined,
    ),
    { connectionSlug: 'healthy', model: 'ready-model' },
  );
});

test('omits transient empty model target fields', () => {
  assert.deepEqual(
    resolveTaskReadinessModelTarget(
      undefined,
      undefined,
      { llmConnectionSlug: ' ', model: '' },
    ),
    {},
  );
});

test('confirmed repair and unavailable states block, while loading uncertainty does not', () => {
  assert.equal(isTaskSubmissionHardBlocked(snapshot('repair_required', 'model_target')), true);
  assert.equal(isTaskSubmissionHardBlocked(snapshot('unavailable', 'runtime')), true);
  assert.equal(
    isTaskSubmissionHardBlocked(snapshot('repair_required', 'model_target'), {
      ignoreModelTarget: true,
    }),
    false,
  );
  assert.equal(isTaskSubmissionHardBlocked(snapshot('unknown', 'runtime')), false);
  assert.equal(isTaskSubmissionHardBlocked(undefined), false);
});

test('model blockers stay owned by existing connection recovery surfaces', () => {
  assert.equal(
    deriveTaskReadinessNotice(snapshot('repair_required', 'model_target'), 'zh'),
    undefined,
  );
});

function snapshot(
  state: TaskSubmissionReadinessSnapshot['state'],
  id: 'runtime' | 'model_target' | 'workspace',
): TaskSubmissionReadinessSnapshot {
  const dimension = {
    id,
    state,
    authority:
      id === 'runtime'
        ? ('runtime_host' as const)
        : id === 'workspace'
          ? ('workspace_execution' as const)
          : ('connection_readiness' as const),
    checkedAt: 1,
    ...(id === 'workspace' ? { repairTarget: { kind: 'workspace_picker' as const } } : {}),
  };
  return {
    checkedAt: 1,
    state,
    dimensions: [dimension],
    blockers: state === 'ready' ? [] : [dimension],
  };
}
