import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createSqliteWorkHubStateStore } from '../workhub/sqlite-workhub-state-store.js';

test('persists the global WorkHub projection and enforces CAS revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-store-'));
  const path = join(root, 'workhub.sqlite');
  try {
    const first = createSqliteWorkHubStateStore(path);
    assert.deepEqual(await first.read(), { revision: 0, items: [] });
    assert.deepEqual(await first.readMetrics(), {
      workhubOpened: 0,
      submissions: 0,
      clarifications: 0,
      manualSessionSwitches: 0,
    });
    await first.incrementMetric('workhub_opened');
    await first.incrementMetric('submission');
    await first.incrementMetric('submission');
    await first.write(0, {
      revision: 1,
      items: [
        {
          kind: 'discussion',
          id: 'item-1',
          sourceRequestId: 'request-1',
          role: 'user',
          text: 'What is active?',
          status: 'completed',
          createdAt: 100,
        },
        {
          kind: 'work',
          id: 'work-1',
          sourceRequestId: 'request-2',
          work: { workspaceId: 'host-1', sessionId: 'session-1' },
          projectName: 'Maka',
          workName: 'Login timeout',
          requestText: 'Fix it.',
          permissionMode: 'ask',
          status: 'waiting_for_user',
          turnId: 'turn-1',
          interaction: {
            interactionId: 'interaction-1',
            request: {
              kind: 'question',
              toolUseId: 'tool-1',
              questions: [{
                question: 'Which target?',
                options: [{ label: 'A' }, { label: 'B', description: 'Second target' }],
              }],
            },
          },
          coordination: { coordinationId: 'coordination-1', nodeId: 'api' },
          createdAt: 101,
          updatedAt: 102,
        },
        {
          kind: 'coordination',
          id: 'coordination-1',
          sourceRequestId: 'request-3',
          title: 'API rollout',
          status: 'active',
          nodes: [
            {
              nodeId: 'api',
              work: { workspaceId: 'host-1', sessionId: 'session-1' },
              projectName: 'Maka',
              workName: 'Login timeout',
              instruction: 'Change API.',
              status: 'waiting_for_user',
              blockId: 'work-1',
            },
            {
              nodeId: 'caller',
              work: { workspaceId: 'host-2', sessionId: 'session-2' },
              projectName: 'Client',
              workName: 'Update caller',
              instruction: 'Update caller.',
              status: 'pending',
            },
          ],
          edges: [{ edgeId: 'edge-1', fromNodeId: 'api', toNodeId: 'caller' }],
          modelSelection: { llmConnectionSlug: 'primary', model: 'model-a' },
          createdAt: 101,
          updatedAt: 102,
        },
      ],
      workFocus: { workspaceId: 'host-1', sessionId: 'session-1' },
      routingMemory: {
        recentFocus: [{ workspaceId: 'host-1', sessionId: 'session-1' }],
        works: [{
          work: { workspaceId: 'host-1', sessionId: 'session-1' },
          projectName: 'Maka',
          workName: 'Login timeout',
          aliases: ['Login timeout'],
          entities: ['刷新令牌'],
          recentRequests: ['检查刷新令牌'],
          recentOutcomes: ['已定位过期逻辑'],
          lastFocusedAt: 102,
          focusCount: 2,
        }],
        corrections: [{
          query: '继续处理令牌问题',
          from: { workspaceId: 'host-2', sessionId: 'session-2' },
          to: { workspaceId: 'host-1', sessionId: 'session-1' },
          correctedAt: 103,
        }],
      },
    });
    await assert.rejects(() => first.write(0, { revision: 1, items: [] }), /REVISION_CONFLICT/);
    first.close();

    const reopened = createSqliteWorkHubStateStore(path);
    const snapshot = await reopened.read();
    assert.deepEqual(await reopened.readMetrics(), {
      workhubOpened: 1,
      submissions: 2,
      clarifications: 0,
      manualSessionSwitches: 0,
    });
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.items[0]?.kind, 'discussion');
    assert.equal(snapshot.items[1]?.kind, 'work');
    if (snapshot.items[1]?.kind === 'work') {
      assert.equal(snapshot.items[1].interaction?.interactionId, 'interaction-1');
      assert.equal(snapshot.items[1].coordination?.coordinationId, 'coordination-1');
    }
    assert.equal(snapshot.items[2]?.kind, 'coordination');
    if (snapshot.items[2]?.kind === 'coordination') {
      assert.deepEqual(snapshot.items[2].modelSelection, {
        llmConnectionSlug: 'primary',
        model: 'model-a',
      });
    }
    assert.deepEqual(snapshot.workFocus, { workspaceId: 'host-1', sessionId: 'session-1' });
    assert.equal(snapshot.routingMemory?.works[0]?.entities[0], '刷新令牌');
    assert.deepEqual(snapshot.routingMemory?.corrections[0]?.to, {
      workspaceId: 'host-1', sessionId: 'session-1',
    });
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('round-trips the persisted resolution of a historical clarification card', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-clarification-store-'));
  const path = join(root, 'workhub.sqlite');
  try {
    const store = createSqliteWorkHubStateStore(path);
    await store.write(0, {
      revision: 1,
      items: [{
        kind: 'clarification',
        id: 'clarification-1',
        sourceRequestId: 'request-1',
        text: '继续重复问题。',
        question: '你指的是哪项工作？',
        options: [{
          candidateId: 'candidate-1',
          work: { workspaceId: 'host-1', sessionId: 'session-1' },
          projectName: 'Maka',
          workName: '支付回调幂等性',
          archived: false,
        }],
        resolvedTo: { workspaceId: 'host-1', sessionId: 'session-1' },
        resolvedAt: 101,
        createdAt: 100,
      }],
    });
    store.close();

    const reopened = createSqliteWorkHubStateStore(path);
    const snapshot = await reopened.read();
    const clarification = snapshot.items[0];
    assert.equal(clarification?.kind, 'clarification');
    if (clarification?.kind === 'clarification') {
      assert.deepEqual(clarification.resolvedTo, {
        workspaceId: 'host-1', sessionId: 'session-1',
      });
      assert.equal(clarification.resolvedAt, 101);
    }
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
