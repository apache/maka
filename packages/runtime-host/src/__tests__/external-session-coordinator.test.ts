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
import { test } from 'node:test';
import {
  ExternalSessionAdapterRegistry,
  type ExternalSessionAdapter,
} from '@maka/core/external-session';
import { type SessionHeader } from '@maka/core/session';
import { headerToSummary } from '@maka/runtime/session-manager';
import type { SessionCatalogRecord } from '@maka/storage/execution-stores';
import {
  EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
  EXTERNAL_SESSION_RESULT_MAX_BYTES,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostExternalSessionCoordinator } from '../server/external-session-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const context: ConnectionContext = {
  hostEpoch: 'external-session-test-epoch',
  connectionId: 'external-session-test-client',
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

test('projects zero import state for never-imported source Sessions with one batch lookup', async () => {
  const fixture = coordinatorFixture([adapterFixture({ count: 2 })]);

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected the external Session catalog');
  assert.deepEqual(
    outcome.result.sessions.map(({ importState }) => importState),
    [
      { importedCount: 0, importedSessionIds: [], isImporting: false },
      { importedCount: 0, importedSessionIds: [], isImporting: false },
    ],
  );
  assert.deepEqual(fixture.lookupCalls, [
    {
      adapterId: 'codex',
      sourceSessionIds: ['source-0', 'source-1'],
      recentSessionIdLimit: EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
    },
  ]);
});

test('projects the complete durable import count and newest eight imported Session ids', async () => {
  const importedSessionIds = Array.from({ length: 8 }, (_, index) => `imported-${12 - index}`);
  const fixture = coordinatorFixture([adapterFixture()], {
    lookupExternalSessionImports: async () => [
      {
        sourceSessionId: 'source-0',
        livePublishedImportCount: 12,
        recentSessionIds: importedSessionIds,
      },
    ],
  });

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected the external Session catalog');
  assert.deepEqual(outcome.result.sessions[0]?.importState, {
    importedCount: 12,
    importedSessionIds,
    isImporting: false,
  });
});

test('reports an unresolved import independently from durable import history', async () => {
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let releaseRead!: () => void;
  const readRelease = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const fixture = coordinatorFixture(
    [
      adapterFixture({
        readSession: async (sourceSessionId) => {
          markReadStarted();
          await readRelease;
          return {
            sourceSessionId,
            metadata: { name: 'Source 0', cwd: '/external' },
            messages: [],
          };
        },
      }),
    ],
    {
      lookupExternalSessionImports: async () => [
        {
          sourceSessionId: 'source-0',
          livePublishedImportCount: 2,
          recentSessionIds: ['imported-2', 'imported-1'],
        },
      ],
    },
  );

  const importing = fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  await readStarted;
  const catalog = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(catalog.ok, true);
  if (!catalog.ok) assert.fail('Expected the external Session catalog');
  assert.deepEqual(catalog.result.sessions[0]?.importState, {
    importedCount: 2,
    importedSessionIds: ['imported-2', 'imported-1'],
    isImporting: true,
  });

  releaseRead();
  assert.equal((await importing).ok, true);
});

test('stops catalog pages before the encoded result limit', async () => {
  const adapter = adapterFixture({ count: 20 });
  adapter.listSessions = async () =>
    Array.from({ length: 20 }, (_, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      cwd: `/${'\u0000'.repeat(4_000)}`,
    }));
  const fixture = coordinatorFixture([adapter], {
    lookupExternalSessionImports: async (_adapterId, sourceSessionIds) =>
      sourceSessionIds.map((sourceSessionId) => ({
        sourceSessionId,
        livePublishedImportCount: 8,
        recentSessionIds: Array.from(
          { length: 8 },
          (_, index) => `${sourceSessionId}-${index}-${'x'.repeat(100)}`,
        ),
      })),
  });

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected a bounded catalog page');
  assert.ok(outcome.result.sessions.length > 0);
  assert.ok(outcome.result.sessions.length < 16);
  assert.equal(outcome.result.nextCursor, String(outcome.result.sessions.length));
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <= EXTERNAL_SESSION_RESULT_MAX_BYTES,
  );
  assert.equal(fixture.lookupCalls.length, 1);
  assert.equal(fixture.lookupCalls[0]?.sourceSessionIds.length, 16);
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
    fixture.creates.map(({ input, messages, externalOrigin }) => ({
      cwd: input.cwd,
      name: input.name,
      messageTypes: messages.map(({ type }) => type),
      externalOrigin,
    })),
    [
      {
        cwd: '/external',
        name: 'Source 0',
        messageTypes: ['user'],
        externalOrigin: { adapterId: 'codex', sourceSessionId: 'source-0' },
      },
      {
        cwd: '/external',
        name: 'Source 0',
        messageTypes: ['user'],
        externalOrigin: { adapterId: 'codex', sourceSessionId: 'source-0' },
      },
    ],
  );
  assert.equal(fixture.drainRequests(), 0);
});

test('coalesces a repeat import issued while the first is still running', async () => {
  // The surface that asks cannot enforce this. 导入任务 is a Settings page the
  // user is free to leave mid-import — the import deliberately continues here —
  // and the page's in-flight state dies with it, so coming back and pressing
  // 导入 again used to land a second task for one intent. A second window or
  // the CLI would have done the same. Nothing is awaited between the two calls
  // below, which is exactly that: two requests for one source, both live.
  const fixture = coordinatorFixture([adapterFixture()]);

  const [first, second] = await Promise.all([
    fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) assert.fail('Expected the coalesced import to commit');
  // Same task, and only one of them was ever created. Both callers are told
  // about it, so the one that clicked twice still gets taken to the result.
  assert.equal(first.result.session.id, second.result.session.id);
  assert.equal(fixture.creates.length, 1);
  assert.equal(fixture.drainRequests(), 0);

  // Only concurrent repeats collapse. Once the first has settled the source is
  // importable again, which is the deliberate second-copy behaviour pinned by
  // the test above.
  const later = await fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  assert.equal(later.ok, true);
  if (!later.ok) assert.fail('Expected a later repeat to commit its own copy');
  assert.notEqual(later.result.session.id, first.result.session.id);
  assert.equal(fixture.creates.length, 2);
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
  storeOverrides: Partial<
    Pick<HostStore, 'createImportedSession' | 'lookupExternalSessionImports'> & {
      prepareImportedSessionHistory(sessionId: string): Promise<void>;
      discardImportedSession(sessionId: string): Promise<void>;
    }
  > = {},
) {
  let sequence = 0;
  let drains = 0;
  const admission = new SessionAdmissionGate();
  const records = new Map<string, SessionCatalogRecord>();
  const creates: Array<{
    input: Parameters<HostStore['createImportedSession']>[0];
    messages: Parameters<HostStore['createImportedSession']>[1];
    externalOrigin: Parameters<HostStore['createImportedSession']>[2];
  }> = [];
  const lookupCalls: Array<{
    adapterId: string;
    sourceSessionIds: readonly string[];
    recentSessionIdLimit: number;
  }> = [];
  const defaultCreate: HostStore['createImportedSession'] = async (
    input,
    messages,
    externalOrigin,
  ) => {
    sequence += 1;
    const header = {
      ...sessionHeader(`imported-${sequence}`, input.cwd, input.name ?? 'Imported'),
      transcriptLedgerVersion: 0 as const,
    };
    creates.push({ input, messages, externalOrigin });
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
    lookupExternalSessionImports: async (adapterId, sourceSessionIds, recentSessionIdLimit) => {
      lookupCalls.push({ adapterId, sourceSessionIds, recentSessionIdLimit });
      return (
        storeOverrides.lookupExternalSessionImports?.(
          adapterId,
          sourceSessionIds,
          recentSessionIdLimit,
        ) ?? []
      );
    },
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
    lookupCalls,
    admission,
    seedStagingSession: () =>
      defaultCreate(
        {
          cwd: '/external',
          llmConnectionSlug: 'default',
          model: 'gpt-5',
          permissionMode: 'ask',
        },
        [],
        { adapterId: 'codex', sourceSessionId: 'source-0' },
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
