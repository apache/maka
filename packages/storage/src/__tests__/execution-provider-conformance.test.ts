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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RunSealedError } from '@maka/core/runtime-event-store';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { AgentGraphScheduleRevisionConflictError } from '@maka/core/agent-graph-schedule';
import type { AgentGraphOperatorProvisionRequest } from '@maka/core/agent-graph-topology';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import type { GoalAuthorityRecord } from '@maka/core/goal';
import { WORKHUB_COORDINATION_SESSION_ID as HUB } from '@maka/core/session';
import { createMemoryExecutionPersistenceProvider } from '../test-only/memory-execution-persistence.js';
import { localExecutionPersistenceProvider } from '../local-execution-persistence.js';
import type { ExecutionPersistenceProvider } from '../execution-persistence-provider.js';
import {
  openInteractiveExecutionStoresForWrite,
  authenticateExecutionStoresWriter,
} from '../execution-stores.js';
import {
  authenticateInteractionStoreWriter,
  closeSqliteInteractionStoreFacade,
  openSqliteInteractiveInteractionStoreForWrite,
} from '../interaction-store.js';
import {
  authenticateInteractiveGoalAuthorityWriter,
  openInteractiveGoalAuthorityForWrite,
} from '../goal-authority.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  runWithStorageRootLease,
  type InteractiveRootOwner,
  StorageRootAuthorityError,
} from '../root-authority.js';
import {
  SessionMetadataConflictError,
  SessionNotFoundError,
  SessionMetadataVersionConflictError,
  type SessionCatalogPageCursor,
  type WorkHubMessageAssignmentRequest,
  type UpdateSessionConfigurationRequest,
} from '../session-store-contract.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);
type Stores = Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
for (const backend of ['Local', 'Memory'] as const) {
  const make = () =>
    backend === 'Local'
      ? localExecutionPersistenceProvider
      : createMemoryExecutionPersistenceProvider();
  test(
    backend + ': catalog hides preparing copies until publication without losing recovery state',
    async () => {
      await withProvider(make(), async ({ sessionStore: s }, root) => {
        const source = await s.create(sessionInput(root));
        const requestFingerprint = `sha256:${'d'.repeat(64)}` as const;
        const conversationCopy = {
          kind: 'branch' as const,
          sourceSessionId: source.id,
          requestFingerprint,
          state: 'preparing' as const,
          intent: 'side_conversation' as const,
        };
        const created = await s.createStableSession({
          sessionId: 'preparing-copy',
          requestFingerprint,
          input: {
            ...sessionInput(root),
            parentSessionId: source.id,
            conversationCopy,
          },
        });
        assert.equal(created.kind, 'created');
        if (created.kind !== 'created') throw new Error('Copy was not created');
        const target = created.record.header.id;
        assert.deepEqual(
          (await s.list()).map((entry) => entry.id),
          [source.id],
        );
        const before = await s.listCatalogPage(undefined, undefined, 1);
        assert.equal(before.kind, 'page');
        if (before.kind !== 'page') throw new Error('Catalog unavailable');
        assert.deepEqual(
          before.records.map((entry) => entry.header.id),
          [source.id],
        );
        assert.equal(before.hasMore, false);
        for (const scope of [undefined, 'ordinary', 'recoverable'] as const) {
          await assert.rejects(s.readCatalogRecord(target, scope), SessionNotFoundError);
        }
        assert.deepEqual(
          (await s.readHeaderRecordSnapshot(target)).header.conversationCopy,
          conversationCopy,
        );
        for (const headers of [await s.listHeaders(), await s.listForRecovery()]) {
          assert.ok(headers.some((header) => header.id === target));
        }
        // A failed publication must not make the staged copy discoverable.
        await assert.rejects(
          s.updateHeaderVersioned(
            target,
            {
              conversationCopy: { ...conversationCopy, state: 'committed' },
            },
            created.record.revision - 1,
          ),
          SessionMetadataVersionConflictError,
        );
        assert.deepEqual(
          (await s.list()).map((entry) => entry.id),
          [source.id],
        );
        await s.updateHeaderVersioned(
          target,
          {
            conversationCopy: { ...conversationCopy, state: 'committed' },
          },
          created.record.revision,
        );
        assert.deepEqual(
          new Set((await s.list()).map((entry) => entry.id)),
          new Set([source.id, target]),
        );
        const after = await s.listCatalogPage(undefined, undefined, 10);
        assert.equal(after.kind, 'page');
        if (after.kind !== 'page') throw new Error('Catalog unavailable');
        assert.deepEqual(
          new Set(after.records.map((entry) => entry.header.id)),
          new Set([source.id, target]),
        );
        assert.equal(after.hasMore, false);
        assert.notEqual(after.revision, before.revision);
        assert.equal(
          (await s.listCatalogPage(undefined, undefined, 1, before.revision)).kind,
          'revision_changed',
        );
        for (const scope of [undefined, 'ordinary', 'recoverable'] as const) {
          assert.equal(
            (await s.readCatalogRecord(target, scope)).header.conversationCopy?.state,
            'committed',
          );
        }
      });
    },
  );
  test(
    backend + ': catalog pagination visits mixed-case tied IDs exactly once in Local order',
    async () => {
      await withProvider(make(), async ({ sessionStore: s }, root) => {
        // Deliberately neither insertion order nor locale order. Session IDs are
        // ASCII; Local's BINARY tie-breaker orders punctuation and case by code.
        const ids = ['b', 'a', '_', 'B', 'A', 'a_', 'a0', '-', 'a-'];
        for (const id of [...ids, 'newer', 'older']) {
          const created = await s.createStableSession({
            sessionId: id,
            requestFingerprint: `sha256:${'e'.repeat(64)}`,
            input: sessionInput(root),
          });
          assert.equal(created.kind, 'created');
          await s.updateHeader(id, {
            createdAt: 50,
            lastMessageAt: id === 'newer' ? 200 : id === 'older' ? 50 : 100,
          });
        }
        const expected = ['newer', '-', 'A', 'B', '_', 'a', 'a-', 'a0', 'a_', 'b', 'older'];
        for (const limit of [1, 2, 3, expected.length, expected.length + 1]) {
          const visited: string[] = [];
          let cursor: SessionCatalogPageCursor | undefined;
          let revision: `sha256:${string}` | undefined;
          for (let pageIndex = 0; ; pageIndex++) {
            assert.ok(pageIndex <= expected.length, 'Pagination did not converge');
            const page = await s.listCatalogPage(undefined, cursor, limit, revision);
            assert.equal(page.kind, 'page');
            if (page.kind !== 'page') throw new Error('Unchanged catalog revision changed');
            revision ??= page.revision;
            assert.equal(page.revision, revision);
            assert.ok(page.records.length <= limit);
            for (const record of page.records) {
              assert.ok(
                !visited.includes(record.header.id),
                'Repeated Session: ' + record.header.id,
              );
              visited.push(record.header.id);
            }
            const last = page.records.at(-1);
            if (last) cursor = { activityAt: last.activityAt, sessionId: last.header.id };
            if (!page.hasMore) break;
            assert.ok(last, 'Nonterminal page must advance');
          }
          assert.deepEqual(visited, expected, `Complete traversal with page size ${limit}`);
          const empty = await s.listCatalogPage(undefined, cursor, limit, revision);
          assert.equal(empty.kind, 'page');
          if (empty.kind !== 'page') throw new Error('Catalog revision changed');
          assert.deepEqual(empty.records, []);
          assert.equal(empty.hasMore, false);
        }
        assert.deepEqual(
          (await s.list()).map((entry) => entry.id),
          expected,
        );
      });
    },
  );
  test(
    backend + ': catalog reads explicitly opt into the recoverable coordination role',
    async () => {
      await withProvider(make(), async ({ sessionStore: s }, root) => {
        const ordinary = await s.create(sessionInput(root));
        await createCoordinationSession(s, root);
        for (const scope of [undefined, 'ordinary', 'recoverable'] as const) {
          assert.equal((await s.readCatalogRecord(ordinary.id, scope)).header.id, ordinary.id);
          await assert.rejects(s.readCatalogRecord('missing', scope), SessionNotFoundError);
        }
        await assert.rejects(s.readCatalogRecord(HUB), SessionNotFoundError);
        await assert.rejects(s.readCatalogRecord(HUB, 'ordinary'), SessionNotFoundError);
        assert.equal((await s.readCatalogRecord(HUB, 'recoverable')).header.id, HUB);
      });
    },
  );
  test(
    backend + ': WorkHub binds delegated text and copied attachments to admission and replay',
    async () => {
      await withProvider(make(), async ({ sessionStore: s }, root) => {
        await createCoordinationSession(s, root);
        const target = await s.create(sessionInput(root));
        const base = assignmentRequest('bound-input', target.id, target.name, 'target-turn');
        const source = {
          kind: 'other' as const,
          name: 'requirements.txt',
          mimeType: 'text/plain',
          bytes: 12,
          ref: { kind: 'session_file' as const, sessionId: HUB, relativePath: 'source.txt' },
        };
        const copied = {
          ...source,
          ref: { ...source.ref, sessionId: target.id, relativePath: 'copy.txt' },
        };
        const delegationText = 'Inspect the payment retry invariants';
        const content = normalizeMessageContent({ text: delegationText, attachments: [copied] });
        const request: WorkHubMessageAssignmentRequest = {
          assignment: {
            ...base.assignment,
            delegationText,
            attachments: [source],
            targetAttachments: [copied],
          },
          admission: {
            ...base.admission,
            content,
            submittedContentDigest: messageContentDigest(content),
          },
        };
        for (const targetAttachments of [undefined, [source], [{ ...copied, bytes: 13 }]]) {
          await assert.rejects(
            s.assignWorkHubMessage({
              ...request,
              assignment: { ...request.assignment, targetAttachments },
            }),
            SessionMetadataConflictError,
          );
          assert.equal(await s.readWorkHubAssignment(base.assignment.actionId), undefined);
          assert.deepEqual(await s.listMessageAdmissions(target.id), []);
        }
        const originalText = normalizeMessageContent({
          text: base.assignment.userText,
          attachments: [copied],
        });
        await assert.rejects(
          s.assignWorkHubMessage({
            ...request,
            admission: {
              ...request.admission,
              content: originalText,
              submittedContentDigest: messageContentDigest(originalText),
            },
          }),
          SessionMetadataConflictError,
        );
        assert.equal((await s.assignWorkHubMessage(request)).kind, 'assigned');
        assert.equal((await s.assignWorkHubMessage(request)).kind, 'existing');
        const changed = normalizeMessageContent({ text: 'Different task', attachments: [copied] });
        await assert.rejects(
          s.assignWorkHubMessage({
            ...request,
            assignment: { ...request.assignment, delegationText: changed.text },
            admission: {
              ...request.admission,
              content: changed,
              submittedContentDigest: messageContentDigest(changed),
            },
          }),
          SessionMetadataConflictError,
        );
        assert.deepEqual(
          await s.readWorkHubAssignment(base.assignment.actionId),
          request.assignment,
        );
        assert.deepEqual(await s.listMessageAdmissions(target.id), [request.admission]);
      });
    },
  );
  test(backend + ': closed children cannot escape the execution group authority', async () => {
    const provider = make();
    await withProvider(provider, async (stores, root, owner) => {
      const session = await stores.sessionStore.create(sessionInput(root));
      await stores.goalStore.commit({
        sessionId: session.id,
        expectedAuthorityRevision: null,
        record: goalRecord(session.id),
      });
      assert.equal(await openInteractiveGoalAuthorityForWrite(owner.lease), stores.goalStore);
      assert.equal(
        await openSqliteInteractiveInteractionStoreForWrite(owner.lease),
        stores.interactionStore,
      );
      await stores.goalStore.close();
      closeSqliteInteractionStoreFacade(stores.interactionStore);
      await assert.rejects(
        openInteractiveGoalAuthorityForWrite(owner.lease),
        StorageRootAuthorityError,
      );
      await assert.rejects(
        openSqliteInteractiveInteractionStoreForWrite(owner.lease),
        StorageRootAuthorityError,
      );
      const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
      await stores.sessionStore.removeSessionsVersioned([
        { sessionId: session.id, expectedVersion: snapshot.revision },
      ]);
      await stores.sessionStore.close?.();
      const reopened = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
      try {
        assert.equal(await reopened.goalStore.read(session.id), null);
        await assert.rejects(stores.goalStore.read(session.id), StorageRootAuthorityError);
        await assert.rejects(stores.interactionStore.listPending(), StorageRootAuthorityError);
      } finally {
        await reopened.sessionStore.close?.();
      }
    });
  });
  test(backend + ': child bindings stay reserved while group close is pending', async () => {
    const backendProvider = make();
    let entered!: () => void, finish!: () => void;
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const raw = await backendProvider.open(input);
        return {
          ...raw,
          async close() {
            entered();
            await release;
            await raw.close();
          },
        };
      },
    };
    await withProvider(provider, async (stores, _root, owner) => {
      const pending = stores.sessionStore.close!();
      try {
        await closing;
        await assert.rejects(
          openInteractiveGoalAuthorityForWrite(owner.lease),
          StorageRootAuthorityError,
        );
        await assert.rejects(
          openSqliteInteractiveInteractionStoreForWrite(owner.lease),
          StorageRootAuthorityError,
        );
      } finally {
        finish();
        await pending;
      }
    });
  });
  test(
    backend + ': conversation copy rebuilds Tool T1/T2 projections and exact retries',
    async () => {
      await withProvider(make(), async ({ runtimeEventStore: r }) => {
        const { prepared, outcome } = toolInputs();
        const { sessionId, runId } = prepared.runtimeEvent;
        const batch = { runId, events: [prepared.runtimeEvent, prepared.dispatchRuntimeEvent] };
        await r.importConversationCopyRuntimeEvents(sessionId, [batch]);
        assert.equal(
          (await r.listUnsettledToolOperations(sessionId))[0]?.operationId,
          prepared.operationId,
        );
        assert.deepEqual(await r.commitToolPrepared(prepared), {
          created: false,
          runtimeEventSeq: 2,
        });
        assert.deepEqual(await r.commitToolOutcome(outcome), { created: true, runtimeEventSeq: 3 });
        const complete = { runId, events: [...batch.events, outcome.runtimeEvent] };
        await r.importConversationCopyRuntimeEvents(sessionId, [complete]);
        assert.deepEqual(await r.commitToolOutcome(outcome), {
          created: false,
          runtimeEventSeq: 3,
        });
        assert.deepEqual(await r.listUnsettledToolOperations(sessionId), []);
        assert.equal((await r.readSessionRuntimeEventEntries(sessionId)).length, 3);
      });
    },
  );
  test(
    backend + ': completed conversation copy can replay T2 without a prior live T1',
    async () => {
      await withProvider(make(), async ({ runtimeEventStore: r }) => {
        const { prepared, outcome } = toolInputs();
        await r.importConversationCopyRuntimeEvents(prepared.runtimeEvent.sessionId, [
          {
            runId: prepared.runtimeEvent.runId,
            events: [prepared.runtimeEvent, prepared.dispatchRuntimeEvent, outcome.runtimeEvent],
          },
        ]);
        assert.deepEqual(await r.commitToolOutcome(outcome), {
          created: false,
          runtimeEventSeq: 3,
        });
      });
    },
  );
  test(backend + ': a lost copy acknowledgement retries without duplicating facts', async () => {
    let lost = false;
    const provider = intercept(
      make(),
      'runtimeEventStore',
      'importConversationCopyRuntimeEvents',
      async (call) => {
        const result = await call();
        if (!lost) {
          lost = true;
          throw new Error('lost copy acknowledgement');
        }
        return result;
      },
    );
    await withProvider(provider, async ({ runtimeEventStore: r }) => {
      const { prepared, outcome } = toolInputs();
      const batches = [
        {
          runId: prepared.runtimeEvent.runId,
          events: [prepared.runtimeEvent, prepared.dispatchRuntimeEvent, outcome.runtimeEvent],
        },
      ];
      await assert.rejects(
        r.importConversationCopyRuntimeEvents(prepared.runtimeEvent.sessionId, batches),
        /lost copy acknowledgement/,
      );
      await r.importConversationCopyRuntimeEvents(prepared.runtimeEvent.sessionId, batches);
      assert.deepEqual(await r.commitToolOutcome(outcome), { created: false, runtimeEventSeq: 3 });
      assert.equal(
        (await r.readSessionRuntimeEventEntries(prepared.runtimeEvent.sessionId)).length,
        3,
      );
    });
  });
  test(
    backend + ': copy cannot steal another Session tool operation during projection rebuild',
    async () => {
      await withProvider(make(), async ({ runtimeEventStore: r }) => {
        const { prepared, outcome } = toolInputs();
        await r.commitToolPrepared(prepared);
        const copied = [
          prepared.runtimeEvent,
          prepared.dispatchRuntimeEvent,
          outcome.runtimeEvent,
        ].map((e) => ({
          ...e,
          id: 'copy-' + e.id,
          sessionId: 'copy-session',
          runId: 'copy-run',
          invocationId: 'copy-invocation',
        }));
        await assert.rejects(
          r.importConversationCopyRuntimeEvents('copy-session', [
            { runId: 'copy-run', events: copied },
          ]),
        );
        assert.deepEqual(await r.readSessionRuntimeEventEntries('copy-session'), []);
        assert.equal(
          (await r.listUnsettledToolOperations(prepared.runtimeEvent.sessionId)).length,
          1,
        );
        assert.deepEqual(await r.commitToolOutcome(outcome), { created: true, runtimeEventSeq: 3 });
      });
    },
  );
  test(
    backend + ': copied recovery bundles preserve parked state and reject incomplete evidence',
    async () => {
      await withProvider(make(), async ({ runtimeEventStore: r }) => {
        const { prepared } = toolInputs();
        const dispatch: RuntimeEvent = {
          ...prepared.dispatchRuntimeEvent,
          actions: {
            toolDispatch: {
              ...prepared.dispatchRuntimeEvent.actions!.toolDispatch!,
              recoveryMode: 'reconcile',
            },
          },
        };
        const reconcile: RuntimeEvent = {
          ...dispatch,
          id: 'reconcile',
          actions: {
            toolRecovery: {
              kind: 'maka.tool.reconcile_result',
              version: 1,
              payload: {
                protocol: 'tool_reconcile_v1',
                operationId: prepared.operationId,
                observation: 'matches_prior_state',
                observationSchema: 'state_identity_v1',
                observationDigest: ('sha256:' + '1'.repeat(64)) as `sha256:${string}`,
              },
            },
          },
        };
        const decision: RuntimeEvent = {
          ...dispatch,
          id: 'decision',
          actions: {
            toolRecovery: {
              kind: 'maka.tool.recovery_decision',
              version: 1,
              payload: {
                protocol: 'tool_recovery_v1',
                operationId: prepared.operationId,
                disposition: 'parked',
                reasonCode: 'reconcile_matches_prior_state',
                evidenceEventIds: [prepared.runtimeEvent.id, dispatch.id, reconcile.id],
              },
            },
          },
        };
        const { sessionId, runId } = prepared.runtimeEvent;
        await assert.rejects(
          r.importConversationCopyRuntimeEvents(sessionId, [
            { runId, events: [prepared.runtimeEvent, dispatch, decision] },
          ]),
        );
        assert.deepEqual(await r.readSessionRuntimeEventEntries(sessionId), []);
        const batch = { runId, events: [prepared.runtimeEvent, dispatch, reconcile, decision] };
        await r.importConversationCopyRuntimeEvents(sessionId, [batch]);
        await r.importConversationCopyRuntimeEvents(sessionId, [batch]);
        assert.deepEqual(await r.listUnsettledToolOperations(sessionId), []);
        assert.equal((await r.readSessionRuntimeEventEntries(sessionId)).length, 4);
        assert.equal(
          (
            await r.commitToolPrepared({
              ...prepared,
              dispatchRuntimeEvent: dispatch,
              recoveryMode: 'reconcile',
            })
          ).created,
          false,
        );
      });
    },
  );
  test(
    backend + ': corrupt copy and conflicting run retries roll back the whole import',
    async () => {
      await withProvider(make(), async ({ runtimeEventStore: r }) => {
        const { prepared, outcome } = toolInputs();
        const { sessionId, runId } = prepared.runtimeEvent;
        for (const events of [
          [prepared.dispatchRuntimeEvent],
          [prepared.runtimeEvent, prepared.runtimeEvent],
        ]) {
          await assert.rejects(
            r.importConversationCopyRuntimeEvents(sessionId, [{ runId, events }]),
          );
          assert.deepEqual(await r.readSessionRuntimeEventEntries(sessionId), []);
          assert.deepEqual(await r.listUnsettledToolOperations(sessionId), []);
        }
        const events = [prepared.runtimeEvent, prepared.dispatchRuntimeEvent, outcome.runtimeEvent];
        await r.importConversationCopyRuntimeEvents(sessionId, [{ runId, events }]);
        const newEvent: RuntimeEvent = {
          ...prepared.runtimeEvent,
          id: 'other-event',
          runId: 'other-run',
          invocationId: 'other-invocation',
          content: { kind: 'text', text: 'another run' },
        };
        for (const conflicting of [
          events.slice(0, 2),
          [
            ...events,
            { ...newEvent, id: 'suffix', runId, invocationId: prepared.runtimeEvent.invocationId },
          ],
        ]) {
          await assert.rejects(
            r.importConversationCopyRuntimeEvents(sessionId, [
              { runId: newEvent.runId, events: [newEvent] },
              { runId, events: conflicting },
            ]),
          );
          assert.equal((await r.readSessionRuntimeEventEntries(sessionId)).length, 3);
          assert.deepEqual(await r.readImmutableRuntimeEvents(sessionId, newEvent.runId), []);
          assert.deepEqual(await r.commitToolOutcome(outcome), {
            created: false,
            runtimeEventSeq: 3,
          });
        }
      });
    },
  );
  test(
    backend + ': model configuration and no-op updates preserve approved sandbox authority',
    async () => {
      await withProvider(make(), async ({ sessionStore: s }, root) => {
        const session = await s.create({
          ...sessionInput(root),
          llmConnectionId: 'test-connection',
          thinkingLevel: 'high',
        });
        await s.createSandboxBoundaryRequest({
          sessionId: session.id,
          requestId: 'approved',
          turnId: 'turn',
          expansion: {
            filesystem: {
              entries: [{ path: '/outside/approved', scope: 'subtree', access: 'read' }],
            },
          },
          justification: 'Read approved files.',
        });
        await s.settleSandboxBoundaryRequest({
          sessionId: session.id,
          requestId: 'approved',
          decision: 'allow',
        });
        const approved = await s.readExecutionBoundary(session.id);
        assert.equal(approved.revision, 1);
        let snapshot = await s.readHeaderRecordSnapshot(session.id);
        const configuration = sessionConfiguration(snapshot.header);
        const updated = await s.updateSessionConfiguration(session.id, {
          expectedVersion: snapshot.revision,
          configuration: { ...configuration, model: 'new-model' },
          lifecycle: { kind: 'preserve' },
        });
        assert.equal(updated.header.model, 'new-model');
        assert.deepEqual(await s.readExecutionBoundary(session.id), approved);
        snapshot = await s.readHeaderRecordSnapshot(session.id);
        const noop = await s.updateSessionConfiguration(session.id, {
          expectedVersion: snapshot.revision,
          configuration: sessionConfiguration(snapshot.header),
          lifecycle: { kind: 'preserve' },
        });
        assert.deepEqual(noop, snapshot);
        assert.deepEqual(await s.setExecutionBoundaryKind(session.id, 'managed'), approved);
        assert.deepEqual(await s.readHeaderRecordSnapshot(session.id), snapshot);
        await assert.rejects(
          s.updateSessionConfiguration(session.id, {
            expectedVersion: snapshot.revision - 1,
            configuration: { ...configuration, permissionMode: 'bypass' },
            lifecycle: { kind: 'preserve' },
          }),
          SessionMetadataVersionConflictError,
        );
        assert.deepEqual(await s.readExecutionBoundary(session.id), approved);
      });
    },
  );
  test(backend + ': temporary Explore and Bypass restore approved Auto authority', async () => {
    await withProvider(make(), async ({ sessionStore: s }, root) => {
      const session = await s.create(sessionInput(root));
      await s.createSandboxBoundaryRequest({
        sessionId: session.id,
        requestId: 'approved',
        turnId: 'turn',
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/approved', scope: 'subtree', access: 'read' }],
          },
        },
        justification: 'Read approved files.',
      });
      await s.settleSandboxBoundaryRequest({
        sessionId: session.id,
        requestId: 'approved',
        decision: 'allow',
      });
      const approved = await s.readExecutionBoundary(session.id);
      for (const permissionMode of ['explore', 'bypass'] as const) {
        await s.setExecutionBoundaryKind(
          session.id,
          permissionMode === 'bypass' ? 'bypass' : 'managed',
          { permissionMode },
        );
        const restored = await s.setExecutionBoundaryKind(session.id, 'managed', {
          permissionMode: 'ask',
        });
        assert.deepEqual({ ...restored, revision: approved.revision }, approved);
      }
      const before = await sessionAuthority(s, session.id);
      await assert.rejects(
        s.setExecutionBoundaryKind(session.id, 'bypass', { permissionMode: 'ask' }),
      );
      assert.deepEqual(await sessionAuthority(s, session.id), before);
    });
  });
  test(
    backend + ': configuration cannot clear an unrelated block or invalid timestamp',
    async () => {
      await withProvider(make(), async ({ sessionStore: s }, root) => {
        const session = await s.create({
          ...sessionInput(root),
          llmConnectionId: 'test-connection',
        });
        const before = await sessionAuthority(s, session.id);
        const configuration = {
          ...sessionConfiguration(before.record.header),
          permissionMode: 'bypass' as const,
        };
        await assert.rejects(
          s.updateSessionConfiguration(session.id, {
            expectedVersion: before.record.revision,
            configuration,
            lifecycle: { kind: 'clear_connection_block', statusUpdatedAt: 10 },
          }),
          SessionMetadataConflictError,
        );
        assert.deepEqual(await sessionAuthority(s, session.id), before);
        await s.updateHeader(session.id, {
          status: 'blocked',
          blockedReason: 'NO_REAL_CONNECTION',
        });
        const blocked = await sessionAuthority(s, session.id);
        await assert.rejects(
          s.updateSessionConfiguration(session.id, {
            expectedVersion: blocked.record.revision,
            configuration,
            lifecycle: { kind: 'clear_connection_block', statusUpdatedAt: -1 },
          }),
        );
        assert.deepEqual(await sessionAuthority(s, session.id), blocked);
        const unblocked = await s.updateSessionConfiguration(session.id, {
          expectedVersion: blocked.record.revision,
          configuration,
          lifecycle: { kind: 'clear_connection_block', statusUpdatedAt: 10 },
        });
        assert.equal(unblocked.header.status, 'active');
        assert.equal(unblocked.header.blockedReason, undefined);
        assert.equal((await s.readExecutionBoundary(session.id)).kind, 'bypass');
      });
    },
  );
  test(
    backend + ': immutable Session fields, lifecycle no-op and mixed admission ordering',
    async () => {
      await withProvider(make(), async (stores, root) => {
        const s = stores.sessionStore,
          session = await s.create(sessionInput(root));
        for (const patch of [
          { role: 'workhub_coordination' as const },
          { isArchived: true },
          { externalOrigin: undefined },
          { subagentParent: undefined },
        ]) {
          // Exercise runtime rejection even when a caller bypasses the TypeScript boundary.
          await assert.rejects(s.updateHeader(session.id, patch as never));
        }
        const before = await s.readHeaderRecordSnapshot(session.id);
        assert.equal(
          (
            await s.setSessionsArchivedVersioned(
              [{ sessionId: session.id, expectedVersion: before.revision }],
              false,
            )
          )[0]!.revision,
          before.revision,
        );
        const steering = assignmentRequest('steering', session.id, 'Target', 'turn').admission;
        const followups = ['first', 'second'].map((messageId) => ({
          ...steering,
          messageId,
          submittedPlacement: 'next_turn' as const,
          placement: 'next_turn' as const,
          disposition: 'followup' as const,
        }));
        await s.commitMessageAdmission(steering);
        for (const input of followups) await s.commitMessageAdmission(input);
        await assert.rejects(s.reorderMessageAdmissions(session.id, [steering.messageId, 'first']));
        await s.reorderMessageAdmissions(session.id, ['second', 'first']);
        assert.deepEqual(
          (await s.listMessageAdmissions(session.id)).map((v) => v.messageId),
          [steering.messageId, 'second', 'first'],
        );
        await s.commitMessageAdmission({ ...followups[0]!, messageId: 'third' });
        assert.deepEqual(
          (await s.listMessageAdmissions(session.id)).map((v) => v.messageId),
          [steering.messageId, 'second', 'first', 'third'],
        );
      });
    },
  );
  test(
    backend + ': active WorkHub linkage requires target evidence and enforces bounds',
    async () => {
      await withProvider(make(), async (stores, root) => {
        const s = stores.sessionStore;
        await createCoordinationSession(s, root);
        const target = await s.create(sessionInput(root));
        const request = assignmentRequest('evidence', target.id, 'Target', 'turn');
        await s.appendMessage(HUB, request.assignment);
        assert.deepEqual(await s.readActiveWorkHubAssignmentsByTarget([target.id]), []);
        await s.commitMessageAdmission(request.admission);
        assert.deepEqual(await s.readActiveWorkHubAssignmentsByTarget([target.id]), [
          request.assignment,
        ]);
        await s.cancelMessageAdmissions(target.id, [request.admission.messageId]);
        assert.deepEqual(await s.readActiveWorkHubAssignmentsByTarget([target.id]), [
          request.assignment,
        ]);
        await assert.rejects(s.readActiveWorkHubAssignmentsByTarget([target.id], 0));
        await assert.rejects(
          s.readActiveWorkHubAssignmentsByTarget(Array.from({ length: 257 }, () => target.id)),
        );
      });
    },
  );
  test(
    backend + ': operational purge removes tool and Goal facts without deleting the Session',
    async () => {
      await withProvider(make(), async (stores, root) => {
        const { prepared, outcome } = toolInputs();
        const id = prepared.runtimeEvent.sessionId;
        await stores.sessionStore.createStableSession({
          sessionId: id,
          requestFingerprint: 'sha256:' + '1'.repeat(64),
          input: sessionInput(root),
        });
        await stores.goalStore.commit({
          sessionId: id,
          expectedAuthorityRevision: null,
          record: goalRecord(id),
        });
        await stores.runtimeEventStore.commitToolPrepared(prepared);
        await stores.runtimeEventStore.commitToolOutcome(outcome);
        await stores.purgeConversationOperationalState(id);
        await stores.purgeConversationOperationalState(id);
        assert.equal(await stores.goalStore.read(id), null);
        assert.deepEqual(await stores.runtimeEventStore.readSessionRuntimeEvents(id), []);
        assert.equal((await stores.sessionStore.readHeader(id)).id, id);
        assert.equal((await stores.runtimeEventStore.commitToolPrepared(prepared)).created, true);
      });
    },
  );
  test(
    backend + ': close drains entered backend calls and concurrent opens share one owner',
    async () => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = intercept(
        make(),
        'runtimeEventStore',
        'readRuntimeEvents',
        async (operation) => {
          enter();
          await gate;
          return operation();
        },
      );
      await withProvider(provider, async (stores, _root, owner) => {
        assert.deepEqual(
          await Promise.all([
            openInteractiveExecutionStoresForWrite(owner.lease, provider),
            openInteractiveExecutionStoresForWrite(owner.lease, provider),
          ]),
          [stores, stores],
        );
        const read = stores.runtimeEventStore.readRuntimeEvents('session', 'run');
        await entered;
        let closed = false;
        const closing = stores.sessionStore.close!().then(() => {
          closed = true;
        });
        await assert.rejects(stores.sessionStore.listHeaders(), StorageRootAuthorityError);
        assert.equal(closed, false);
        release();
        assert.deepEqual(await read, []);
        await closing;
      });
    },
  );
  test(
    backend + ': uncertain open cannot retry or switch authority on the same lease',
    async () => {
      await withProvider(make(), async (stores, _root, owner) => {
        await stores.sessionStore.close!();
        let attempts = 0;
        const broken: ExecutionPersistenceProvider = {
          open: async () => {
            attempts++;
            throw new Error('uncertain factory open');
          },
        };
        await assert.rejects(
          openInteractiveExecutionStoresForWrite(owner.lease, broken),
          /uncertain factory open/,
        );
        await assert.rejects(
          openInteractiveExecutionStoresForWrite(owner.lease, broken),
          StorageRootAuthorityError,
        );
        await assert.rejects(
          openInteractiveExecutionStoresForWrite(owner.lease, make()),
          StorageRootAuthorityError,
        );
        assert.equal(attempts, 1);
      });
    },
  );
  test(
    backend + ': failed close retains a revoked owner and forbids backend replacement',
    async () => {
      const base = make();
      let closes = 0;
      const provider: ExecutionPersistenceProvider = {
        open: async (input) => {
          const raw = await base.open(input);
          return {
            ...raw,
            close: async () => {
              closes++;
              await raw.close();
              throw new Error('uncertain backend close');
            },
          };
        },
      };
      await assert.rejects(
        withProvider(provider, async (stores, _root, owner) => {
          await assert.rejects(stores.sessionStore.close!(), AggregateError);
          await assert.rejects(
            openInteractiveExecutionStoresForWrite(owner.lease, provider),
            StorageRootAuthorityError,
          );
          await assert.rejects(
            openInteractiveExecutionStoresForWrite(owner.lease, make()),
            StorageRootAuthorityError,
          );
          await assert.rejects(stores.goalStore.list(), StorageRootAuthorityError);
          await assert.rejects(stores.interactionStore.listPending(), StorageRootAuthorityError);
          await assert.rejects(
            openInteractiveGoalAuthorityForWrite(owner.lease),
            StorageRootAuthorityError,
          );
          await assert.rejects(
            openSqliteInteractiveInteractionStoreForWrite(owner.lease),
            StorageRootAuthorityError,
          );
          assert.equal(closes, 1);
        }),
        AggregateError,
      );
    },
  );
  test(backend + ': owner revocation rejects calls in every selected domain', async () => {
    await withProvider(make(), async (stores, _root, owner) => {
      await owner.close();
      assert.throws(
        () => stores.sessionStore.subscribeTranscriptChanges(() => {}),
        StorageRootAuthorityError,
      );
      for (const call of [
        () => stores.sessionStore.listHeaders(),
        () => stores.agentRunStore.readEvents('session', 'run'),
        () => stores.runtimeEventStore.readRuntimeEvents('session', 'run'),
        () => stores.graphControlStore.listAgentGraphIntentClaims(),
        () => stores.interactionStore.listPending(),
        () => stores.goalStore.list(),
      ])
        await assert.rejects(call, StorageRootAuthorityError);
    });
  });
  test(
    backend + ': mid-transaction WorkHub failure publishes none of the four coupled facts',
    async () => {
      await withRollback(backend, 'workhub', async (stores, root, arm) => {
        await createCoordinationSession(stores.sessionStore, root);
        const request = newAssignment(root, 'rollback');
        arm(true);
        await assert.rejects(
          stores.sessionStore.assignWorkHubMessage(request),
          /injected rollback/,
        );
        assert.equal(
          (
            await stores.sessionStore.probeStableSessionCreate(
              'new-target',
              request.create!.requestFingerprint,
            )
          ).kind,
          'absent',
        );
        assert.equal(await stores.sessionStore.readWorkHubAssignment('rollback'), undefined);
        assert.deepEqual(await stores.sessionStore.listMessageAdmissions('new-target'), []);
        assert.deepEqual(
          (await stores.sessionStore.listHeaders()).map((h) => h.id),
          [HUB],
        );
        arm(false);
        assert.equal((await stores.sessionStore.assignWorkHubMessage(request)).kind, 'assigned');
      });
    },
  );
  for (const stage of ['t1', 't2'] as const)
    test(
      backend +
        ': ' +
        stage +
        ' mid-transaction failure rolls back the ledger and operation journal',
      async () => {
        await withRollback(backend, stage, async (stores, _root, arm) => {
          const { prepared, outcome } = toolInputs(),
            s = stores.runtimeEventStore;
          if (stage === 't2') await s.commitToolPrepared(prepared);
          arm(true);
          await assert.rejects(
            stage === 't1' ? s.commitToolPrepared(prepared) : s.commitToolOutcome(outcome),
            /injected rollback/,
          );
          assert.equal(
            (await s.readImmutableRuntimeEvents('tool-session', 'tool-run')).length,
            stage === 't1' ? 0 : 2,
          );
          assert.equal(
            (await s.listUnsettledToolOperations('tool-session')).length,
            stage === 't1' ? 0 : 1,
          );
          arm(false);
          assert.equal(
            (await (stage === 't1' ? s.commitToolPrepared(prepared) : s.commitToolOutcome(outcome)))
              .created,
            true,
          );
        });
      },
    );
  test(
    backend + ': handoff preserves distinct admission times and rejects wrong or absent proofs',
    async () => {
      await withProvider(make(), async (stores, root) => {
        const session = await stores.sessionStore.create(sessionInput(root)),
          s = stores.sessionStore;
        const input = assignmentRequest('handoff', session.id, 'Target', 'admitted-turn').admission;
        await s.commitMessageAdmission(input);
        await assert.rejects(
          s.markMessagesHandedOff({
            sessionId: session.id,
            turnId: 'wrong-turn',
            messageIds: [input.messageId],
          }),
          SessionMetadataConflictError,
        );
        await assert.rejects(
          s.claimMessageAdmissionCancellation(session.id, 'never-admitted', 'claim'),
          SessionMetadataConflictError,
        );
        const proof = {
          messageId: input.messageId,
          content: input.content,
          admittedAt: input.admittedAt + 100,
        };
        await s.markMessagesHandedOff({
          sessionId: session.id,
          turnId: input.turnId,
          messageIds: [input.messageId],
          provenRootMessages: [proof],
        });
        assert.deepEqual(await s.listMessageAdmissions(session.id), []);
        await s.markMessagesHandedOff({
          sessionId: session.id,
          turnId: input.turnId,
          messageIds: [input.messageId],
          provenRootMessages: [proof],
        });
        await assert.rejects(
          s.markMessagesHandedOff({
            sessionId: session.id,
            turnId: input.turnId,
            messageIds: ['never-admitted'],
          }),
          SessionMetadataConflictError,
        );
      });
    },
  );
  test(
    backend + ': Graph schedule fence and Session provisioning share one authority',
    async () => {
      await withProvider(make(), async (stores, root) => {
        const s = stores.sessionStore,
          g = stores.graphControlStore;
        await s.createStableSession({
          sessionId: 'supervisor-session',
          requestFingerprint: 'sha256:' + 'a'.repeat(64),
          input: sessionInput(root),
        });
        const request = graphProvision(),
          child = graphChild(root, request);
        await g.commitAgentGraphScheduleUpdate({
          schemaVersion: 1,
          updateId: 'graph_update_' + '1'.repeat(32),
          updateFingerprint: 'sha256:' + '2'.repeat(64),
          graphId: request.graphId,
          source: {
            sessionId: 'supervisor-session',
            runId: 'supervisor-run',
            turnId: 'supervisor-turn',
            toolCallId: 'schedule-tool',
          },
          addWork: [
            {
              workId: request.workId,
              target: { kind: 'agent', agentId: request.agentId },
              instruction: 'Inspect input',
              inputIds: [],
            },
          ],
          stop: [],
        });
        await assert.rejects(
          s.createAgentGraphOperator(child, request, 0),
          AgentGraphScheduleRevisionConflictError,
        );
        assert.deepEqual(await g.listAgentGraphOperatorProvisions(request.graphId), []);
        assert.equal((await s.listHeaders()).length, 1);
        const created = await s.createAgentGraphOperator(child, request, 1);
        assert.equal(created.created, true);
        const retry = await s.createAgentGraphOperator(child, request, 1);
        assert.equal(retry.created, false);
        assert.equal(retry.header.id, created.header.id);
        assert.deepEqual(await g.listAgentGraphOperatorProvisions(request.graphId), [
          created.provision,
        ]);
        const claim = {
          schemaVersion: 1 as const,
          claimId: 'graph_claim_' + '7'.repeat(32),
          graphId: request.graphId,
          intentId: 'graph_intent_' + '8'.repeat(32),
          intentFingerprint: 'sha256:' + '9'.repeat(64),
          readinessContextFingerprint: 'sha256:' + 'a'.repeat(64),
          targetOperatorId: request.operatorId,
          targetSessionId: created.header.id,
          targetTurnId: 'next-turn',
          targetRunId: 'next-run',
        };
        assert.equal((await g.claimAgentGraphIntentAtScheduleRevision(claim, 1)).created, true);
        assert.equal(
          (
            await g.claimAgentGraphIntentAtScheduleRevision(
              { ...claim, targetRunId: 'discarded-proposal' },
              1,
            )
          ).claim.targetRunId,
          'next-run',
        );
        assert.deepEqual(
          await g.beginAgentGraphIntentExecutionAtScheduleRevision(
            request.graphId,
            claim.intentId,
            1,
          ),
          { state: 'executing', previousState: 'claimed', changed: true },
        );
        const snapshot = await g.readAgentGraphTimelineMetadata(request.graphId);
        assert.equal(snapshot.operatorProvisions[0]?.targetSessionId, created.header.id);
        assert.equal(snapshot.intentAdmissions[0]?.state, 'executing');
        await assert.rejects(s.remove(created.header.id), SessionMetadataConflictError);
      });
    },
  );
  test(
    backend + ': stable create, detached snapshots, metadata CAS and message admission identity',
    async () => {
      await withProvider(make(), async (stores, root) => {
        const s = stores.sessionStore,
          request = {
            sessionId: 'stable',
            requestFingerprint: ('sha256:' + 'a'.repeat(64)) as `sha256:${string}`,
            input: sessionInput(root),
          };
        assert.equal((await s.createStableSession(request)).kind, 'created');
        assert.equal(
          (
            await s.createStableSession({
              ...request,
              input: { ...request.input, name: 'retry title' },
            })
          ).kind,
          'existing',
        );
        assert.equal(
          (
            await s.createStableSession({
              ...request,
              requestFingerprint: 'sha256:' + 'b'.repeat(64),
            })
          ).kind,
          'conflict',
        );
        const record = await s.readHeaderRecordSnapshot('stable');
        const original = record.header.name;
        try {
          record.header.name = 'corrupted by reader';
        } catch {}
        assert.equal((await s.readHeader('stable')).name, original);
        const results = await Promise.allSettled([
          s.updateHeaderVersioned('stable', { name: 'one' }, record.revision),
          s.updateHeaderVersioned('stable', { name: 'two' }, record.revision),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.ok(
          results.some(
            (r) =>
              r.status === 'rejected' && r.reason instanceof SessionMetadataVersionConflictError,
          ),
        );
        const admission = assignmentRequest(
          'pending',
          'stable',
          'Stable',
          'pending-turn',
        ).admission;
        await s.commitMessageAdmission(admission);
        await s.commitMessageAdmission(admission);
        assert.deepEqual(await s.listMessageAdmissions('stable'), [admission]);
        await assert.rejects(
          s.commitMessageAdmission({ ...admission, turnId: 'other-turn' }),
          SessionMetadataConflictError,
        );
      });
    },
  );
  test(
    backend +
      ': WorkHub assignment publishes target, pending message and coordination fact together',
    async () => {
      await withProvider(make(), async (stores, root) => {
        const s = stores.sessionStore;
        await createCoordinationSession(s, root);
        const request = newAssignment(root, 'atomic');
        const bad = { ...request, admission: { ...request.admission, sessionId: 'wrong-target' } };
        await assert.rejects(s.assignWorkHubMessage(bad), SessionMetadataConflictError);
        assert.equal(await s.readWorkHubAssignment(request.assignment.actionId), undefined);
        assert.equal(
          (
            await s.probeStableSessionCreate(
              request.create!.sessionId,
              request.create!.requestFingerprint,
            )
          ).kind,
          'absent',
        );
        assert.equal((await s.assignWorkHubMessage(request)).kind, 'assigned');
        assert.equal((await s.assignWorkHubMessage(request)).kind, 'existing');
        assert.deepEqual(
          await s.readWorkHubAssignment(request.assignment.actionId),
          request.assignment,
        );
        assert.deepEqual(await s.listMessageAdmissions(request.admission.sessionId), [
          request.admission,
        ]);
        assert.equal(
          (await s.readMessages(HUB)).filter((m) => m.id === request.assignment.id).length,
          1,
        );
        await assert.rejects(
          s.assignWorkHubMessage({
            ...request,
            assignment: { ...request.assignment, targetTurnId: 'different-turn' },
          }),
          SessionMetadataConflictError,
        );
        assert.deepEqual(
          await s.readWorkHubAssignment(request.assignment.actionId),
          request.assignment,
        );
      });
    },
  );
  test(
    backend + ': lost WorkHub acknowledgement is recovered by an exact retry after reopen',
    async () => {
      let lost = true;
      const provider = intercept(
        make(),
        'sessionStore',
        'assignWorkHubMessage',
        async (operation) => {
          const result = await operation();
          if (lost) {
            lost = false;
            throw new Error('lost acknowledgement');
          }
          return result;
        },
      );
      await withProvider(provider, async (stores, root, owner) => {
        await createCoordinationSession(stores.sessionStore, root);
        const request = newAssignment(root, 'lost-ack');
        await assert.rejects(
          stores.sessionStore.assignWorkHubMessage(request),
          /lost acknowledgement/,
        );
        await stores.sessionStore.close?.();
        const reopened = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
        try {
          assert.equal(
            (await reopened.sessionStore.assignWorkHubMessage(request)).kind,
            'existing',
          );
          assert.deepEqual(
            await reopened.sessionStore.listMessageAdmissions(request.admission.sessionId),
            [request.admission],
          );
          assert.equal(
            (await reopened.sessionStore.readMessages(HUB)).filter(
              (m) => m.id === request.assignment.id,
            ).length,
            1,
          );
        } finally {
          await reopened.sessionStore.close?.();
        }
      });
    },
  );
  test(backend + ': T1/T2 atomicity, replay, identity conflicts and terminal seal', async () => {
    await withProvider(make(), async (stores) => {
      const s = stores.runtimeEventStore,
        { prepared, outcome } = toolInputs();
      await assert.rejects(s.commitToolOutcome(outcome));
      assert.deepEqual(await s.readImmutableRuntimeEvents('tool-session', 'tool-run'), []);
      const committed = await s.commitToolPrepared(prepared);
      assert.equal(committed.created, true);
      assert.equal((await s.commitToolPrepared(prepared)).created, false);
      assert.equal((await s.listUnsettledToolOperations('tool-session')).length, 1);
      await assert.rejects(
        s.commitToolPrepared({ ...prepared, canonicalArgsHash: 'sha256:' + 'f'.repeat(64) }),
      );
      assert.equal((await s.readImmutableRuntimeEvents('tool-session', 'tool-run')).length, 2);
      assert.equal((await s.commitToolOutcome(outcome)).created, true);
      assert.equal((await s.commitToolOutcome(outcome)).created, false);
      assert.deepEqual(await s.listUnsettledToolOperations('tool-session'), []);
      await assert.rejects(
        s.commitToolOutcome({
          ...outcome,
          runtimeEvent: { ...outcome.runtimeEvent, id: 'other-result' },
        }),
      );
      assert.equal((await s.readImmutableRuntimeEvents('tool-session', 'tool-run')).length, 3);
      const terminal: RuntimeEvent = {
        ...prepared.dispatchRuntimeEvent,
        id: 'terminal',
        actions: { endInvocation: true },
        status: 'completed',
      };
      await s.ensureTerminalRuntimeEventDurable('tool-session', 'tool-run', terminal);
      await s.ensureTerminalRuntimeEventDurable('tool-session', 'tool-run', terminal);
      await assert.rejects(
        s.appendRuntimeEvent('tool-session', 'tool-run', {
          ...terminal,
          id: 'late',
          actions: undefined,
          status: undefined,
        }),
        RunSealedError,
      );
      const detached = await s.readImmutableRuntimeEvents('tool-session', 'tool-run');
      detached[0]!.author = 'user';
      assert.notEqual(
        (await s.readImmutableRuntimeEvents('tool-session', 'tool-run'))[0]!.author,
        'user',
      );
    });
  });
  for (const stage of ['commitToolPrepared', 'commitToolOutcome'] as const) {
    test(backend + ': ' + stage + ' lost acknowledgement does not duplicate facts', async () => {
      let lost = true;
      const provider = intercept(make(), 'runtimeEventStore', stage, async (operation) => {
        const result = await operation();
        if (lost) {
          lost = false;
          throw new Error('lost acknowledgement');
        }
        return result;
      });
      await withProvider(provider, async (stores) => {
        const s = stores.runtimeEventStore,
          { prepared, outcome } = toolInputs();
        if (stage === 'commitToolPrepared') {
          await assert.rejects(s.commitToolPrepared(prepared), /lost acknowledgement/);
          assert.equal((await s.commitToolPrepared(prepared)).created, false);
          assert.equal((await s.readImmutableRuntimeEvents('tool-session', 'tool-run')).length, 2);
          assert.equal((await s.listUnsettledToolOperations('tool-session')).length, 1);
        } else {
          await s.commitToolPrepared(prepared);
          await assert.rejects(s.commitToolOutcome(outcome), /lost acknowledgement/);
          assert.equal((await s.commitToolOutcome(outcome)).created, false);
          assert.equal((await s.readImmutableRuntimeEvents('tool-session', 'tool-run')).length, 3);
          assert.deepEqual(await s.listUnsettledToolOperations('tool-session'), []);
        }
      });
    });
  }
  test(
    backend + ': authentic grouped authority rejects backend mixing and retained calls after close',
    async () => {
      const provider = make();
      await withProvider(provider, async (stores, _root, owner) => {
        assert.equal(authenticateExecutionStoresWriter(stores, 'interactive'), stores);
        assert.equal(
          authenticateInteractionStoreWriter(stores.interactionStore),
          stores.interactionStore,
        );
        assert.equal(
          authenticateInteractiveGoalAuthorityWriter(stores.goalStore),
          stores.goalStore,
        );
        assert.equal(await openInteractiveExecutionStoresForWrite(owner.lease, provider), stores);
        await assert.rejects(
          openInteractiveExecutionStoresForWrite(
            owner.lease,
            createMemoryExecutionPersistenceProvider(),
          ),
          StorageRootAuthorityError,
        );
        await stores.sessionStore.close?.();
        assert.throws(
          () => authenticateExecutionStoresWriter(stores, 'interactive'),
          StorageRootAuthorityError,
        );
        for (const operation of [
          () => stores.sessionStore.listHeaders(),
          () => stores.agentRunStore.readEventsForRecovery('s', 'r'),
          () => stores.runtimeEventStore.readRuntimeEvents('s', 'r'),
          () => stores.interactionStore.listPending(),
          () => stores.graphControlStore.listAgentGraphIntentClaims(),
          () => stores.goalStore.list(),
        ])
          await assert.rejects(operation, StorageRootAuthorityError);
        assert.throws(
          () => authenticateInteractionStoreWriter(stores.interactionStore),
          StorageRootAuthorityError,
        );
      });
    },
  );
  test(backend + ': Goal CAS and Session retirement use the same transaction domain', async () => {
    await withProvider(make(), async (stores, root) => {
      const s = await stores.sessionStore.create(sessionInput(root));
      const record = goalRecord(s.id);
      assert.equal(
        (
          await stores.goalStore.commit({
            sessionId: s.id,
            expectedAuthorityRevision: null,
            record,
          })
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.goalStore.commit({ sessionId: s.id, expectedAuthorityRevision: null, record }),
        { kind: 'revision_conflict', actualAuthorityRevision: 0 },
      );
      const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(s.id);
      await stores.sessionStore.removeSessionsVersioned([
        { sessionId: s.id, expectedVersion: snapshot.revision },
      ]);
      assert.equal(await stores.goalStore.read(s.id), null);
      await assert.rejects(stores.sessionStore.readHeader(s.id));
    });
  });
}

test('Local standalone child close/reopen remains compatible with later group composition', async () => {
  await withProvider(localExecutionPersistenceProvider, async (initial, _root, owner) => {
    await initial.sessionStore.close?.();
    const firstGoal = await openInteractiveGoalAuthorityForWrite(owner.lease);
    const firstInteraction = await openSqliteInteractiveInteractionStoreForWrite(owner.lease);
    await firstGoal.close();
    closeSqliteInteractionStoreFacade(firstInteraction);
    const goal = await openInteractiveGoalAuthorityForWrite(owner.lease);
    const interaction = await openSqliteInteractiveInteractionStoreForWrite(owner.lease);
    assert.notEqual(goal, firstGoal);
    assert.notEqual(interaction, firstInteraction);
    const group = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      assert.equal(group.goalStore, goal);
      assert.equal(group.interactionStore, interaction);
      await goal.close();
      closeSqliteInteractionStoreFacade(interaction);
      await assert.rejects(
        openInteractiveGoalAuthorityForWrite(owner.lease),
        StorageRootAuthorityError,
      );
      await assert.rejects(
        openSqliteInteractiveInteractionStoreForWrite(owner.lease),
        StorageRootAuthorityError,
      );
    } finally {
      await group.sessionStore.close?.();
    }
  });
});

async function withRollback(
  backend: 'Local' | 'Memory',
  stage: 'workhub' | 't1' | 't2',
  run: (stores: Stores, root: string, arm: (enabled: boolean) => void) => Promise<void>,
) {
  let armed = false;
  const operation = {
    workhub: 'workhub.assign',
    t1: 'runtime.toolPrepared',
    t2: 'runtime.toolOutcome',
  }[stage];
  const provider =
    backend === 'Local'
      ? localExecutionPersistenceProvider
      : createMemoryExecutionPersistenceProvider({
          beforeCommit: (name) => {
            if (armed && name === operation) throw new Error('injected rollback');
          },
        });
  await withProvider(provider, async (stores, root, owner) => {
    const database =
      backend === 'Local'
        ? await runWithStorageRootLease(owner.lease, 'interactive', 'write', async (path) =>
            acquireOperationalStateDatabase(path),
          )
        : undefined;
    const arm = (enabled: boolean) => {
      armed = enabled;
      if (!database) return;
      database.database.exec('DROP TRIGGER IF EXISTS provider_rollback');
      if (!enabled) return;
      const target =
        stage === 'workhub'
          ? 'BEFORE INSERT ON session_messages'
          : stage === 't1'
            ? 'BEFORE INSERT ON tool_operations'
            : 'BEFORE UPDATE ON tool_operations';
      database.database.exec(
        'CREATE TEMP TRIGGER provider_rollback ' +
          target +
          " BEGIN SELECT RAISE(ABORT, 'injected rollback'); END",
      );
    };
    try {
      await run(stores, root, arm);
    } finally {
      arm(false);
      database?.close();
    }
  });
}
function graphProvision(): AgentGraphOperatorProvisionRequest {
  return {
    schemaVersion: 1,
    provisionId: 'graph_provision_' + '4'.repeat(32),
    provisionFingerprint: 'sha256:' + '5'.repeat(64),
    graphId: 'graph-1',
    workId: 'graph_work_' + '3'.repeat(32),
    agentId: 'local-read',
    operatorId: 'graph_operator_' + '6'.repeat(32),
    initialTurnId: 'graph-turn',
    initialRunId: 'graph-run',
    edges: [],
  };
}
function graphChild(root: string, r: AgentGraphOperatorProvisionRequest): CreateSessionInput {
  return {
    ...sessionInput(root),
    subagentParent: {
      kind: 'subagent',
      parentSessionId: 'supervisor-session',
      spawnedBy: {
        parentRunId: 'supervisor-run',
        parentTurnId: 'supervisor-turn',
        toolCallId: 'schedule-tool',
      },
      graph: { graphId: r.graphId, workId: r.workId, operatorId: r.operatorId },
      lifecycle: 'foreground',
    },
    subagentRuntime: {
      schemaVersion: 1,
      definitionVersion: 1,
      agentId: r.agentId,
      agentName: 'Local Read',
      profile: 'local_read',
      systemPrompt: 'Read only.',
      toolNames: ['Read'],
      categoryPolicy: { read: 'allow' },
    },
    subagentSpawn: {
      schemaVersion: 1,
      requestFingerprint: '5'.repeat(64),
      initialTurnId: r.initialTurnId,
      initialRunId: r.initialRunId,
    },
  };
}
async function sessionAuthority(s: Stores['sessionStore'], id: string) {
  return {
    record: await s.readHeaderRecordSnapshot(id),
    boundary: await s.readExecutionBoundary(id),
  };
}
function sessionConfiguration(
  header: Awaited<ReturnType<Stores['sessionStore']['readHeader']>>,
): UpdateSessionConfigurationRequest['configuration'] {
  return {
    backend: header.backend,
    llmConnectionId: header.llmConnectionId!,
    llmConnectionSlug: header.llmConnectionSlug!,
    connectionLocked: header.connectionLocked ?? false,
    model: header.model,
    thinkingLevel: header.thinkingLevel,
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
    labels: header.labels ?? [],
  };
}
function sessionInput(root: string) {
  return {
    cwd: root,
    name: 'Target',
    llmConnectionSlug: 'test',
    model: 'test',
    permissionMode: 'ask' as const,
  };
}
function newAssignment(root: string, actionId: string): WorkHubMessageAssignmentRequest {
  const base = assignmentRequest(actionId, 'new-target', 'Target', 'target-turn');
  return {
    ...base,
    assignment: {
      ...base.assignment,
      disposition: 'create_new',
      create: { title: 'Target', workspace: { kind: 'host_path', path: root } },
    },
    create: {
      sessionId: 'new-target',
      requestFingerprint: 'sha256:' + 'b'.repeat(64),
      input: sessionInput(root),
    },
  };
}
function toolInputs() {
  const base = {
    sessionId: 'tool-session',
    runId: 'tool-run',
    turnId: 'tool-turn',
    invocationId: 'tool-invocation',
    ts: 10,
    partial: false,
  };
  const args = { path: '/workspace/README.md' },
    hash = canonicalToolArgsHash('Read', args);
  const call: RuntimeEvent = {
    ...base,
    id: 'call',
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: 'provider-call', name: 'Read', args },
  };
  const dispatch: RuntimeEvent = {
    ...base,
    id: 'dispatch',
    role: 'system',
    author: 'system',
    refs: { operationId: 'operation', toolCallId: 'provider-call' },
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation',
        providerToolCallId: 'provider-call',
        toolName: 'Read',
        canonicalArgsHash: hash,
        recoveryMode: 'replay_safe',
      },
    },
  };
  const result: RuntimeEvent = {
    ...base,
    id: 'result',
    role: 'tool',
    author: 'tool',
    refs: { operationId: 'operation', toolCallId: 'provider-call' },
    content: { kind: 'function_response', id: 'provider-call', name: 'Read', result: 'contents' },
  };
  return {
    prepared: {
      operationId: 'operation',
      journalEventId: 'operation_prepared',
      runtimeEvent: call,
      dispatchRuntimeEvent: dispatch,
      providerToolCallId: 'provider-call',
      toolName: 'Read',
      canonicalArgsHash: hash,
      recoveryMode: 'replay_safe' as const,
      committedAt: 10,
    },
    outcome: {
      operationId: 'operation',
      journalEventId: 'operation_outcome',
      runtimeEvent: result,
      committedAt: 20,
    },
  };
}
function goalRecord(sessionId: string): GoalAuthorityRecord {
  return {
    schemaVersion: 1,
    goal: {
      id: 'goal',
      revision: 0,
      sessionId,
      condition: 'Complete reference conformance',
      status: 'active',
      setAt: 1,
      iterations: 0,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: true,
    },
    controlLease: { goalId: 'goal', generation: 0 },
    currentExecution: null,
  };
}
function intercept(
  provider: ExecutionPersistenceProvider,
  port: 'sessionStore' | 'runtimeEventStore',
  method: string,
  around: (operation: () => Promise<unknown>) => Promise<unknown>,
): ExecutionPersistenceProvider {
  return {
    async open(input) {
      const raw = await provider.open(input);
      const wrapped = new Proxy(raw[port], {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) =>
            property === method
              ? around(async () => Reflect.apply(value, target, args))
              : Reflect.apply(value, target, args);
        },
      });
      return { ...raw, [port]: wrapped };
    },
  };
}
async function withProvider(
  provider: ExecutionPersistenceProvider,
  run: (stores: Stores, root: string, owner: InteractiveRootOwner) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-contract-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let stores: Stores | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
    await run(stores, root, owner);
  } finally {
    try {
      await stores?.sessionStore.close?.();
    } finally {
      try {
        await owner.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}
