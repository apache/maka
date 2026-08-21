import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkHubSnapshot, WorkHubWorkBlock } from '@maka/core/workhub';
import { projectWorkHubLifecycleNotifications } from '../workhub/workhub-product-events.js';

test('projects only actionable WorkHub lifecycle transitions', () => {
  const running = snapshot(work('running'));
  assert.deepEqual(projectWorkHubLifecycleNotifications({ revision: 0, items: [] }, running), []);

  const waiting = snapshot(work('waiting_for_user', 'Approve the command.'));
  assert.deepEqual(projectWorkHubLifecycleNotifications(running, waiting), [{
    kind: 'waiting_for_user',
    title: 'Maka / Login timeout',
    body: 'Approve the command.',
  }]);
  assert.deepEqual(projectWorkHubLifecycleNotifications(waiting, waiting), []);

  const completed = snapshot(work('completed'));
  assert.deepEqual(projectWorkHubLifecycleNotifications(waiting, completed), [{
    kind: 'completed',
    title: 'Maka / Login timeout',
  }]);

  const failed = snapshot(work('failed', 'Tests failed.'));
  assert.deepEqual(projectWorkHubLifecycleNotifications(running, failed), [{
    kind: 'errored',
    title: 'Maka / Login timeout',
    body: 'Tests failed.',
  }]);

  assert.deepEqual(projectWorkHubLifecycleNotifications(running, snapshot(work('stopped'))), []);
});

function snapshot(block: WorkHubWorkBlock): WorkHubSnapshot {
  return { revision: block.updatedAt, items: [block] };
}

function work(status: WorkHubWorkBlock['status'], detail?: string): WorkHubWorkBlock {
  return {
    kind: 'work', id: 'work-1', sourceRequestId: 'request-1',
    work: { workspaceId: 'host-1', sessionId: 'session-1' },
    projectName: 'Maka', workName: 'Login timeout', requestText: 'Fix it.',
    permissionMode: 'ask', status, ...(detail ? { detail } : {}),
    createdAt: 1, updatedAt: status === 'running' ? 1 : 2,
  };
}
