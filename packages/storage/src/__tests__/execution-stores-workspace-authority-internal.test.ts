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
import test from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { openInteractiveExecutionStoresForWrite } from '../execution-stores.js';
import {
  issueExecutionStoresWorkspaceMutationAuthorityInternal,
  requireExecutionStoresWorkspaceMutationAuthorityInternal,
} from '../execution-stores-workspace-authority-internal.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';

test('binds workspace mutation persistence to one execution-stores owner capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-execution-workspace-authority-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  if (!rootOwner) return;
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  try {
    const ownerToken = {};
    const authorityCapability = issueExecutionStoresWorkspaceMutationAuthorityInternal({
      ownerToken,
      stores,
      verifyCandidate: () => {
        throw new Error('not used');
      },
    });
    assert.throws(
      () => requireExecutionStoresWorkspaceMutationAuthorityInternal({}, authorityCapability),
      /capability is invalid/i,
    );
    const authority = requireExecutionStoresWorkspaceMutationAuthorityInternal(
      ownerToken,
      authorityCapability,
    );
    assert.equal(
      await authority.readHead(
        'workspace_'.concat('1'.repeat(32)),
        'epoch_'.concat('2'.repeat(32)),
      ),
      undefined,
    );
  } finally {
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a no-effect proof issued by another execution store', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'maka-no-effect-authority-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'maka-no-effect-authority-b-'));
  const [capabilityA, capabilityB] = await Promise.all([
    resolveStorageRoot({ path: rootA, kind: 'interactive' }),
    resolveStorageRoot({ path: rootB, kind: 'interactive' }),
  ]);
  const [rootOwnerA, rootOwnerB] = await Promise.all([
    tryAcquireInteractiveRootOwner(capabilityA),
    tryAcquireInteractiveRootOwner(capabilityB),
  ]);
  assert.ok(rootOwnerA);
  assert.ok(rootOwnerB);
  if (!rootOwnerA || !rootOwnerB) return;
  const [storesA, storesB] = await Promise.all([
    openInteractiveExecutionStoresForWrite(rootOwnerA.lease),
    openInteractiveExecutionStoresForWrite(rootOwnerB.lease),
  ]);
  try {
    const ownerTokenA = {};
    const ownerTokenB = {};
    const authorityA = requireExecutionStoresWorkspaceMutationAuthorityInternal(
      ownerTokenA,
      issueExecutionStoresWorkspaceMutationAuthorityInternal({
        ownerToken: ownerTokenA,
        stores: storesA,
        verifyCandidate: () => {
          throw new Error('not used');
        },
      }),
    );
    const authorityB = requireExecutionStoresWorkspaceMutationAuthorityInternal(
      ownerTokenB,
      issueExecutionStoresWorkspaceMutationAuthorityInternal({
        ownerToken: ownerTokenB,
        stores: storesB,
        verifyCandidate: () => {
          throw new Error('not used');
        },
      }),
    );
    const claim = {
      operationId: 'operation-cross-store',
      dispatchEventId: 'dispatch-cross-store',
      workspaceInstanceId: `instance_${'8'.repeat(32)}`,
      terminalKind: 'no_workspace_change' as const,
    };
    const runtimeEvent: RuntimeEvent = {
      id: 'outcome-cross-store',
      sessionId: 'session-cross-store',
      invocationId: 'run-cross-store',
      runId: 'run-cross-store',
      turnId: 'turn-cross-store',
      ts: 2,
      partial: false,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'call-cross-store',
        name: 'Write',
        result: 'unchanged',
      },
      actions: {
        managedMutationTerminal: {
          protocol: 'managed_mutation_terminal_v1',
          ...claim,
        },
      },
      refs: { operationId: claim.operationId, toolCallId: 'call-cross-store' },
    };

    await assert.rejects(
      async () =>
        authorityB.commitTerminal({
          noEffectOutcome: authorityA.issueNoEffectOutcome(claim),
          toolOutcome: {
            operationId: claim.operationId,
            journalEventId: 'journal-cross-store',
            runtimeEvent,
            committedAt: 2,
          },
        }),
      /no-effect proof is invalid/i,
    );
  } finally {
    await Promise.all([storesA.sessionStore.close?.(), storesB.sessionStore.close?.()]);
    await Promise.all([rootOwnerA.close(), rootOwnerB.close()]);
    await Promise.all([
      rm(rootA, { recursive: true, force: true }),
      rm(rootB, { recursive: true, force: true }),
    ]);
  }
});
