import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { toDesktopHostSessionSummary } from '../runtime-host-session-catalog-ipc-main.js';

test('maps Runtime Host live run state without collapsing unknown and known-empty', () => {
  const unknown = toDesktopHostSessionSummary(projection());
  const knownEmpty = toDesktopHostSessionSummary(
    projection({ liveRunState: { schemaVersion: 1, runningTurnIds: [] } }),
  );
  const running = toDesktopHostSessionSummary(
    projection({ liveRunState: { schemaVersion: 1, runningTurnIds: ['turn-live'] } }),
  );

  assert.equal(Object.hasOwn(unknown, 'runningTurnIds'), false);
  assert.deepEqual(knownEmpty.runningTurnIds, []);
  assert.deepEqual(running.runningTurnIds, ['turn-live']);
});

function projection(overrides: Partial<SessionCatalogProjection> = {}): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}
