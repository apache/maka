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
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '@maka/storage/root-authority';
import { SessionConfigurationTransitionError } from '@maka/runtime/session-manager';
import {
  HostSessionBundleCoordinator,
  subtreeDigest,
} from '../server/session-bundle-coordinator.js';

async function withLease<T>(
  run: (lease: StorageRootLease<'interactive', 'write'>, root: string) => Promise<T>,
): Promise<T> {
  const root = join(await mkdtemp(join(tmpdir(), 'maka-bundle-coordinator-')), 'workspace');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, 'the fixture stands in for a Runtime Host holding its root');
  try {
    return await run(owner.lease, owner.capability.canonicalPath);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

test('prepares a bundle under the authority the Host already holds', async () => {
  await withLease(async (lease, canonicalRoot) => {
    const fenced: string[] = [];
    const coordinator = new HostSessionBundleCoordinator({
      lease,
      fenceSubtree: async (sessionId, operation) => {
        fenced.push(sessionId);
        return operation([sessionId]);
      },
      onImported: () => {},
    });

    const outcome = await coordinator.export({
      sessionId: 'session-1',
      destination: join(canonicalRoot, 'out.maka-session'),
    });

    // The Session fence is the Host's, not the export's: the export refuses a
    // Session already mid-turn, this stops one from starting. Both are needed,
    // and only this one is the coordinator's to apply.
    assert.deepEqual(fenced, ['session-1']);
    // No Session exists in this empty root, so the outcome is the failure --
    // what matters here is that it got that far under the lease rather than
    // being refused by the root's own lock.
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.notEqual(outcome.error.code, 'internal_failure');
  });
});

test('accepts a bundle without fencing Sessions that are not here yet', async () => {
  await withLease(async (lease, canonicalRoot) => {
    let fenced = false;
    const coordinator = new HostSessionBundleCoordinator({
      lease,
      fenceSubtree: async (sessionId, operation) => {
        fenced = true;
        return operation([sessionId]);
      },
      onImported: () => {},
    });

    const outcome = await coordinator.import({
      source: join(canonicalRoot, 'absent.maka-session'),
    });

    // Nothing to fence by id: the Sessions being imported do not exist in this
    // workspace. What has to be exclusive is the context store, and the import
    // takes that turn itself.
    //
    // This says nothing about the lease reaching the import -- the bundle is
    // absent, so it returns before any authority is needed. That the lease is
    // what makes an import possible while a Host holds the root is proven one
    // layer down, in `@maka/runtime`'s `imports under authority the caller
    // already holds`.
    assert.equal(fenced, false);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, 'source_unreadable');
  });
});

test('a fence that refuses a running Session refuses the export', async () => {
  await withLease(async (lease, canonicalRoot) => {
    const coordinator = new HostSessionBundleCoordinator({
      lease,
      fenceSubtree: async () => {
        throw new Error('Session configuration cannot change while a linked Turn is active');
      },
      onImported: () => {},
    });

    await assert.rejects(() =>
      coordinator.export({
        sessionId: 'session-1',
        destination: join(canonicalRoot, 'out.maka-session'),
      }),
    );
  });
});

test('a busy subtree is refused as busy, not as a broken Host', async () => {
  await withLease(async (lease, canonicalRoot) => {
    const coordinator = new HostSessionBundleCoordinator({
      lease,
      fenceSubtree: async () => {
        // What PRODUCTION delivers: the kernel raises its own error and the
        // Session manager re-throws it as a configuration transition, so a test
        // that threw the kernel type would exercise a path nothing takes.
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session configuration cannot change while a linked Turn is active',
        );
      },
      onImported: () => {},
    });

    const outcome = await coordinator.export({
      sessionId: 'session-1',
      destination: join(canonicalRoot, 'out.maka-session'),
    });

    // `internal_failure` is the code that says something is broken, and a
    // running Session is the most ordinary thing that can happen here.
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, 'session_busy');
  });
});

test('refuses a subtree whose membership changed, not only its size', async () => {
  await withLease(async (lease, canonicalRoot) => {
    const coordinator = new HostSessionBundleCoordinator({
      lease,
      // The caller was shown two Sessions; a third finished spawning while the
      // save dialog was open.
      fenceSubtree: async (sessionId, operation) => operation([sessionId, 'child-1', 'child-2']),
      onImported: () => {},
    });

    const outcome = await coordinator.export({
      sessionId: 'session-1',
      destination: join(canonicalRoot, 'out.maka-session'),
      expectedSubtreeDigest: subtreeDigest(['session-1', 'child-1']),
    });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, 'candidate_set_stale');
  });
});

test('exports when the subtree is what the caller was shown', async () => {
  await withLease(async (lease, canonicalRoot) => {
    const coordinator = new HostSessionBundleCoordinator({
      lease,
      fenceSubtree: async (sessionId, operation) => operation([sessionId, 'child-1']),
      onImported: () => {},
    });

    const outcome = await coordinator.export({
      sessionId: 'session-1',
      destination: join(canonicalRoot, 'out.maka-session'),
      expectedSubtreeDigest: subtreeDigest(['session-1', 'child-1']),
    });

    // The empty root has no such Session, so this fails on the export itself --
    // what matters is that the size check let it through to get there.
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.notEqual(outcome.error.code, 'candidate_set_stale');
  });
});
