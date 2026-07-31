import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultRuntimePolicy,
  DEEP_RESEARCH_SESSION_LABEL,
  EXPERT_TEAM_LABEL_PREFIX,
  type SessionHeader,
} from '@maka/core';
import { SessionConfigurationTransitionError, headerToSummary } from '@maka/runtime';
import {
  SessionMetadataVersionConflictError,
  type SessionCatalogRecord,
} from '@maka/storage/execution-stores';
import type { SessionConfigurationUpdateInput } from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  HostSessionCatalogCoordinator,
  type HostSessionCatalogCoordinatorOptions,
} from '../server/session-catalog-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

type CatalogStores = HostSessionCatalogCoordinatorOptions['stores'];
type RuntimePolicy = HostSessionCatalogCoordinatorOptions['runtimePolicy'];
type ConfigurationAuthority = HostSessionCatalogCoordinatorOptions['manager'];
type SessionContinuity = HostSessionCatalogCoordinatorOptions['continuity'];

const context: ConnectionContext = {
  hostEpoch: 'session-catalog-test-epoch',
  connectionId: 'session-catalog-test-client',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('metadata replacement preserves execution-semantic labels and ignores injected ones', async () => {
  const fixture = createFixture({
    labels: ['old-user-label', DEEP_RESEARCH_SESSION_LABEL, `${EXPERT_TEAM_LABEL_PREFIX}review`],
  });

  const outcome = await fixture.coordinator.handlers['session.metadata.update'](
    {
      sessionId: fixture.sessionId,
      expectedRevision: fixture.revision(),
      patch: {
        labels: [
          'new-user-label',
          `${EXPERT_TEAM_LABEL_PREFIX}injected`,
          DEEP_RESEARCH_SESSION_LABEL,
        ],
      },
    },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok || outcome.result.kind !== 'committed') {
    assert.fail('Metadata replacement did not commit');
  }
  if ('kind' in outcome.result.session) {
    assert.fail('Metadata replacement returned an unsupported Session projection');
  }
  assert.deepEqual(outcome.result.session.labels, [
    'new-user-label',
    DEEP_RESEARCH_SESSION_LABEL,
    `${EXPERT_TEAM_LABEL_PREFIX}review`,
  ]);
  assert.equal(fixture.drainRequests(), 0);
});

test('metadata commit uncertainty requests Host drain, while a typed conflict does not', async () => {
  const uncertain = createFixture({
    continuity: {
      refreshCanonical: async () => {
        throw new Error('injected publication failure');
      },
    },
  });
  const uncertainOutcome = await uncertain.coordinator.handlers['session.metadata.update'](
    {
      sessionId: uncertain.sessionId,
      expectedRevision: uncertain.revision(),
      patch: { isFlagged: true },
    },
    context,
  );
  assert.deepEqual(uncertainOutcome, {
    ok: false,
    error: {
      code: 'commit_outcome_unknown',
      message: 'Session metadata update outcome is unknown',
    },
  });
  assert.equal(uncertain.drainRequests(), 1);

  const conflict = createFixture({
    stores: {
      updateHeaderVersioned: async (sessionId, _patch, expectedRevision) => {
        throw new SessionMetadataVersionConflictError(
          sessionId,
          expectedRevision,
          expectedRevision + 1,
        );
      },
    },
  });
  const conflictOutcome = await conflict.coordinator.handlers['session.metadata.update'](
    {
      sessionId: conflict.sessionId,
      expectedRevision: conflict.revision(),
      patch: { isFlagged: true },
    },
    context,
  );
  assert.deepEqual(conflictOutcome, {
    ok: true,
    result: {
      kind: 'revision_conflict',
      expectedRevision: conflict.revision(),
      actualRevision: conflict.revision() + 1,
    },
  });
  assert.equal(conflict.drainRequests(), 0);
});

test('configuration failures distinguish pre-commit loss from post-commit uncertainty', async () => {
  const preCommit = createFixture({
    stores: {
      readHeaderRecordSnapshot: async () => {
        throw new Error('injected pre-commit read failure');
      },
    },
  });
  const preCommitOutcome = await preCommit.coordinator.handlers['session.configuration.update'](
    configurationInput(preCommit.sessionId, preCommit.revision()),
    context,
  );
  assert.deepEqual(preCommitOutcome, {
    ok: false,
    error: {
      code: 'persistence_failed',
      message: 'Session configuration authority is unavailable',
    },
  });
  assert.equal(preCommit.drainRequests(), 1);

  const postCommit = createFixture({
    manager: {
      transitionSessionConfiguration: async () => {
        throw new Error('injected commit-unknown failure');
      },
    },
  });
  const postCommitOutcome = await postCommit.coordinator.handlers['session.configuration.update'](
    configurationInput(postCommit.sessionId, postCommit.revision()),
    context,
  );
  assert.deepEqual(postCommitOutcome, {
    ok: false,
    error: {
      code: 'commit_outcome_unknown',
      message: 'Session configuration update outcome is unknown',
    },
  });
  assert.equal(postCommit.drainRequests(), 1);
});

test('typed configuration rejection does not request Host drain', async () => {
  const fixture = createFixture({
    manager: {
      transitionSessionConfiguration: async () => {
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session configuration cannot change while a linked Turn is active',
        );
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.configuration.update'](
    configurationInput(fixture.sessionId, fixture.revision()),
    context,
  );

  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'session_busy',
      message: 'Session configuration cannot change while a linked Turn is active',
    },
  });
  assert.equal(fixture.drainRequests(), 0);
});

function createFixture(
  options: {
    readonly labels?: readonly string[];
    readonly stores?: Partial<CatalogStores>;
    readonly manager?: Partial<ConfigurationAuthority>;
    readonly continuity?: Partial<SessionContinuity>;
  } = {},
) {
  const sessionId = 'session-1';
  let revision = 3;
  let header = sessionHeader(sessionId, options.labels ?? ['user-label']);
  let drains = 0;

  const stores: CatalogStores = {
    createStableSession: async () => ({
      kind: 'existing',
      record: headerSnapshot(header, revision),
    }),
    listCatalogPage: async () => ({
      kind: 'page',
      revision: 'sha256:test',
      records: [catalogRecord(header, revision)],
      hasMore: false,
    }),
    markSessionReadThroughMessage: async () => headerSnapshot(header, revision),
    probeStableSessionCreate: async () => ({ kind: 'absent' }),
    readCatalogRecord: async () => catalogRecord(header, revision),
    readHeaderRecordSnapshot: async () => headerSnapshot(header, revision),
    updateHeaderVersioned: async (_sessionId, patch, expectedRevision) => {
      if (expectedRevision !== revision) {
        throw new SessionMetadataVersionConflictError(sessionId, expectedRevision, revision);
      }
      header = { ...header, ...patch };
      revision += 1;
      return headerSnapshot(header, revision);
    },
    ...options.stores,
  };
  const runtimePolicy = runtimePolicyFixture();
  const manager: ConfigurationAuthority = {
    transitionSessionConfiguration: async (_sessionId, input) => {
      header = {
        ...header,
        ...input.configuration,
      };
      revision += 1;
      return headerSnapshot(header, revision);
    },
    ...options.manager,
  };
  const continuity: SessionContinuity = {
    refreshCanonical: async () => undefined,
    ...options.continuity,
  };
  const coordinator = new HostSessionCatalogCoordinator({
    stores,
    runtimePolicy,
    manager,
    admission: new SessionAdmissionGate(),
    continuity,
    requestDrain: () => {
      drains += 1;
    },
  });
  return {
    coordinator,
    sessionId,
    revision: () => revision,
    drainRequests: () => drains,
  };
}

function runtimePolicyFixture(): RuntimePolicy {
  const policy = createDefaultRuntimePolicy();
  const connection = {
    connectionId: 'connection-1',
    revision: 1,
    slug: 'test',
    name: 'Test',
    providerType: 'openai' as const,
    enabled: true,
    enabledModelIds: ['model-1'],
    models: [{ id: 'model-1' }],
  };
  return {
    connectionCatalog: {
      getSnapshot: async () => ({
        revision: 1,
        defaultTarget: {
          connectionId: connection.connectionId,
          modelId: 'model-1',
        },
        connections: [connection],
      }),
    },
    runtimePolicy: {
      getSnapshot: async () => ({ revision: 1, policy }),
    },
    operations: {
      resolveExecutionConnection: async () => ({
        kind: 'ready',
        connection,
        secretMaterial: {},
        networkProxy: policy.networkProxy,
      }),
    },
  };
}

function configurationInput(
  sessionId: string,
  expectedRevision: number,
): SessionConfigurationUpdateInput {
  return {
    sessionId,
    expectedRevision,
    configuration: {
      modelTarget: {
        kind: 'explicit',
        connectionSlug: 'test',
        model: 'model-1',
      },
      thinkingLevel: null,
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'graph',
    },
  };
}

function sessionHeader(sessionId: string, labels: readonly string[]): SessionHeader {
  return {
    id: sessionId,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
    titleIsManual: false,
    isFlagged: false,
    labels: [...labels],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}

function headerSnapshot(header: SessionHeader, revision: number) {
  return { header, revision, committedAt: revision };
}

function catalogRecord(header: SessionHeader, revision: number): SessionCatalogRecord {
  return {
    ...headerSnapshot(header, revision),
    summary: headerToSummary(header),
  };
}
