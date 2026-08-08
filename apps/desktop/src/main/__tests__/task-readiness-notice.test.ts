import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core';
import {
  deriveTaskReadinessNotice,
  isTaskSubmissionHardBlocked,
} from '../../renderer/task-readiness-notice.js';

test('confirmed repair and unavailable states block, while loading uncertainty does not', () => {
  assert.equal(isTaskSubmissionHardBlocked(snapshot('repair_required', 'model_target')), true);
  assert.equal(isTaskSubmissionHardBlocked(snapshot('unavailable', 'runtime')), true);
  assert.equal(isTaskSubmissionHardBlocked(snapshot('unknown', 'runtime')), false);
  assert.equal(isTaskSubmissionHardBlocked(undefined), false);
});

test('runtime and workspace blockers produce actionable localized notices', () => {
  const runtime = deriveTaskReadinessNotice(snapshot('unavailable', 'runtime'), 'en');
  assert.equal(runtime?.action, 'retry');
  assert.match(runtime?.title ?? '', /runtime/i);

  const workspace = deriveTaskReadinessNotice(snapshot('unavailable', 'workspace'), 'zh');
  assert.equal(workspace?.action, 'new_task');
  assert.match(workspace?.title ?? '', /工作区/);
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
  };
  return {
    checkedAt: 1,
    state,
    dimensions: [dimension],
    blockers: state === 'ready' ? [] : [dimension],
  };
}
