import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExternalSessionAdapterRegistry,
  type ExternalSessionAdapter,
} from '@maka/core/external-session';
import { type SessionHeader, type StoredMessage } from '@maka/core/session';
import { headerToSummary } from '@maka/runtime/session-manager';
import type { SessionCatalogRecord } from '@maka/storage/execution-stores';
import { EXTERNAL_SESSION_RESULT_MAX_BYTES } from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostExternalSessionCoordinator } from '../server/external-session-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const context: ConnectionContext = {
  hostEpoch: 'external-session-test-epoch',
  connectionId: 'external-session-test-client',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('discovers detected adapters and pages bounded source summaries', async () => {
  const adapter = adapterFixture({ count: 20 });
  const unavailable = adapterFixture({ id: 'unavailable', detected: false });
  const invalidId = adapterFixture({ id: 'invalid.source' });
  const fixture = coordinatorFixture([adapter, unavailable, invalidId]);

  assert.deepEqual(
    await fixture.coordinator.handlers['external-session.source.query']({}, context),
    { ok: true, result: { adapterIds: ['codex'] } },
  );

  const first = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );
  assert.equal(first.ok, true);
  if (!first.ok) assert.fail('Expected the first catalog page');
  assert.equal(first.result.sessions.length, 16);
  assert.equal(first.result.nextCursor, '16');

  const second = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex', cursor: first.result.nextCursor ?? undefined },
    context,
  );
  assert.equal(second.ok, true);
  if (!second.ok) assert.fail('Expected the second catalog page');
  assert.equal(second.result.sessions.length, 4);
  assert.equal(second.result.nextCursor, null);
});

test('resolves a Project filter before calling the Host adapter', async () => {
  const adapter = adapterFixture();
  const filters: unknown[] = [];
  adapter.listSessions = async (input) => {
    filters.push(input);
    return [];
  };
  const fixture = coordinatorFixture([adapter]);

  const result = await fixture.coordinator.handlers['external-session.catalog.query'](
    {
      adapterId: 'codex',
      workspace: { kind: 'project', projectId: 'project-1' },
      includeArchived: true,
    },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(filters, [{ cwd: '/resolved-project', includeArchived: true }]);
});

test('stops catalog pages before the encoded result limit', async () => {
  const adapter = adapterFixture({ count: 20 });
  adapter.listSessions = async () =>
    Array.from({ length: 20 }, (_, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      cwd: `/${'\u0000'.repeat(4_000)}`,
    }));
  const fixture = coordinatorFixture([adapter]);

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected a bounded catalog page');
  assert.ok(outcome.result.sessions.length > 0);
  assert.ok(outcome.result.sessions.length < 16);
  assert.ok(outcome.result.nextCursor);
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <= EXTERNAL_SESSION_RESULT_MAX_BYTES,
  );
});

test('imports through the generic importer and treats repeats as independent copies', async () => {
  const fixture = coordinatorFixture([adapterFixture()]);

  const first = await fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  const second = await fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) assert.fail('Expected both imports to commit');
  assert.notEqual(first.result.session.id, second.result.session.id);
  assert.deepEqual(
    fixture.creates.map(({ input, messages }) => ({
      cwd: input.cwd,
      name: input.name,
      backend: input.backend,
      messageTypes: messages.map(({ type }) => type),
    })),
    [
      { cwd: '/external', name: 'Source 0', backend: 'ai-sdk', messageTypes: ['user'] },
      { cwd: '/external', name: 'Source 0', backend: 'ai-sdk', messageTypes: ['user'] },
    ],
  );
  assert.equal(fixture.drainRequests(), 0);
});

test('reports conversion errors before persistence and store uncertainty after entry', async () => {
  let createAttempts = 0;
  const conversionFailure = coordinatorFixture(
    [
      adapterFixture({
        readSession: async () => {
          throw new Error('malformed rollout');
        },
      }),
    ],
    {
      createImportedSession: async () => {
        createAttempts += 1;
        assert.fail('Conversion failure must not enter persistence');
      },
    },
  );
  assert.deepEqual(
    await conversionFailure.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: { code: 'invalid_request', message: 'External Session could not be converted' },
    },
  );
  assert.equal(createAttempts, 0);
  assert.equal(conversionFailure.drainRequests(), 0);

  const persistenceFailure = coordinatorFixture([adapterFixture()], {
    createImportedSession: async () => {
      throw new Error('commit acknowledgement lost');
    },
  });
  assert.deepEqual(
    await persistenceFailure.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'commit_outcome_unknown',
        message:
          'External Session import outcome is unknown; check the Session list before retrying',
      },
    },
  );
  assert.equal(persistenceFailure.drainRequests(), 1);
});

test('removes an imported Session when its model history cannot be prepared', async () => {
  const fixture = coordinatorFixture([adapterFixture()], {
    prepareImportedSessionHistory: async () => {
      throw new Error('ledger repair failed');
    },
  });

  assert.deepEqual(
    await fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'persistence_failed',
        message: 'External Session history could not be prepared',
      },
    },
  );
  assert.equal(fixture.hasRecord('imported-1'), false);
  assert.equal(fixture.drainRequests(), 0);
});

test('holds Session admission through failed history preparation and cleanup', async () => {
  let markPreparationStarted!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    markPreparationStarted = resolve;
  });
  let releasePreparation!: () => void;
  const preparationRelease = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let discarded = false;
  const fixture = coordinatorFixture([adapterFixture()], {
    prepareImportedSessionHistory: async () => {
      markPreparationStarted();
      await preparationRelease;
      throw new Error('ledger repair failed');
    },
    discardImportedSession: async () => {
      discarded = true;
    },
  });

  const importing = fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  await preparationStarted;
  let competingAdmissionEntered = false;
  const competingAdmission = fixture.admission.run('imported-1', () => {
    competingAdmissionEntered = true;
    assert.equal(discarded, true);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(competingAdmissionEntered, false);

  releasePreparation();
  const outcome = await importing;
  await competingAdmission;

  assert.equal(outcome.ok, false);
  assert.equal(competingAdmissionEntered, true);
  assert.equal(fixture.drainRequests(), 0);
});

test('recovers or discards staged imported Sessions after restart', async () => {
  const recovered = coordinatorFixture([adapterFixture()]);
  await recovered.seedStagingSession();
  assert.equal(recovered.readHeader('imported-1')?.transcriptLedgerVersion, 0);

  await recovered.coordinator.recover();

  assert.equal(recovered.readHeader('imported-1')?.transcriptLedgerVersion, 1);

  const discarded = coordinatorFixture([adapterFixture()], {
    prepareImportedSessionHistory: async () => {
      throw new Error('ledger repair failed');
    },
  });
  await discarded.seedStagingSession();

  await discarded.coordinator.recover();

  assert.equal(discarded.hasRecord('imported-1'), false);
  assert.equal(discarded.drainRequests(), 0);
});

function coordinatorFixture(
  adapters: readonly ExternalSessionAdapter[],
  storeOverrides: Partial<{
    createImportedSession(
      input: Parameters<HostStore['createImportedSession']>[0],
      messages: readonly StoredMessage[],
    ): Promise<SessionHeader>;
    prepareImportedSessionHistory(sessionId: string): Promise<void>;
    discardImportedSession(sessionId: string): Promise<void>;
  }> = {},
) {
  let sequence = 0;
  let drains = 0;
  const admission = new SessionAdmissionGate();
  const records = new Map<string, SessionCatalogRecord>();
  const creates: Array<{
    input: Parameters<HostStore['createImportedSession']>[0];
    messages: readonly StoredMessage[];
  }> = [];
  const defaultCreate: HostStore['createImportedSession'] = async (input, messages) => {
    sequence += 1;
    const header = {
      ...sessionHeader(`imported-${sequence}`, input.cwd, input.name ?? 'Imported'),
      transcriptLedgerVersion: 0 as const,
    };
    creates.push({ input, messages });
    records.set(header.id, {
      header,
      revision: 1,
      committedAt: 1,
      summary: headerToSummary(header),
    });
    return header;
  };
  const store: HostStore = {
    createImportedSession: storeOverrides.createImportedSession ?? defaultCreate,
    listHeaders: async () => [...records.values()].map((record) => record.header),
    readCatalogRecord: async (sessionId) => {
      const record = records.get(sessionId);
      if (!record) throw new Error(`missing record: ${sessionId}`);
      return record;
    },
  };
  return {
    coordinator: new HostExternalSessionCoordinator({
      adapters: new ExternalSessionAdapterRegistry(adapters),
      admission,
      sessions: store,
      workspaceResolver: {
        resolve: async (target) =>
          target.kind === 'host_path'
            ? { target, cwd: target.path, projectId: null }
            : {
                target,
                cwd: '/resolved-project',
                projectId: target.projectId,
                project: {
                  id: target.projectId,
                  name: 'Project',
                  locations: [{ path: '/resolved-project', isWorktree: false }],
                  available: true,
                  preferredPath: '/resolved-project',
                },
              },
      },
      resolveTarget: async () => ({
        backend: 'ai-sdk',
        llmConnectionSlug: 'default',
        model: 'gpt-5',
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      }),
      prepareImportedSessionHistory:
        storeOverrides.prepareImportedSessionHistory ??
        (async (sessionId) => {
          const record = records.get(sessionId);
          if (!record) throw new Error(`missing record: ${sessionId}`);
          const header = { ...record.header, transcriptLedgerVersion: 1 as const };
          records.set(sessionId, {
            ...record,
            header,
            revision: record.revision + 1,
            summary: headerToSummary(header),
          });
        }),
      discardImportedSession:
        storeOverrides.discardImportedSession ??
        (async (sessionId) => {
          records.delete(sessionId);
        }),
      requestDrain: () => {
        drains += 1;
      },
    }),
    creates,
    admission,
    seedStagingSession: () =>
      defaultCreate(
        {
          cwd: '/external',
          backend: 'ai-sdk',
          llmConnectionSlug: 'default',
          model: 'gpt-5',
          permissionMode: 'ask',
        },
        [],
      ),
    readHeader: (sessionId: string) => records.get(sessionId)?.header,
    hasRecord: (sessionId: string) => records.has(sessionId),
    drainRequests: () => drains,
  };
}

type HostStore = ConstructorParameters<typeof HostExternalSessionCoordinator>[0]['sessions'];

function adapterFixture(
  options: {
    id?: string;
    detected?: boolean;
    count?: number;
    readSession?: ExternalSessionAdapter['readSession'];
  } = {},
): ExternalSessionAdapter {
  const count = options.count ?? 1;
  return {
    id: options.id ?? 'codex',
    detect: async () => options.detected ?? true,
    listSessions: async () =>
      Array.from({ length: count }, (_, index) => ({
        id: `source-${index}`,
        name: `Source ${index}`,
        cwd: '/external',
        updatedAt: index,
      })),
    readSession:
      options.readSession ??
      (async (sourceSessionId) => ({
        sourceSessionId,
        metadata: { name: 'Source 0', cwd: '/external' },
        messages: [
          {
            type: 'user',
            id: 'message-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'hello',
          },
        ],
      })),
  };
}

function sessionHeader(id: string, cwd: string, name: string): SessionHeader {
  return {
    id,
    workspaceRoot: '/workspace',
    cwd,
    createdAt: 1,
    lastUsedAt: 1,
    name,
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}
