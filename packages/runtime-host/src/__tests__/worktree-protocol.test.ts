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
  decodeRequestFrame,
  decodeSessionCreateInput,
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
} from '../protocol/index.js';
import {
  authorizeRuntimeHostOperation,
  createRuntimeHostConnectionAuthority,
  LOCAL_OWNER_CONNECTION_AUTHORITY,
} from '../server/connection-authority.js';

test('configuring the Host worktree root requires Host-path authority', () => {
  const remote = createRuntimeHostConnectionAuthority({
    principalKind: 'remote_owner',
    principalId: 'remote-client',
    credentialId: 'remote-credential',
    operationGrants: REMOTE_OWNER_OPERATION_GRANTS,
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
  });
  const authorizedRemote = createRuntimeHostConnectionAuthority({
    ...remote,
    canUseHostPaths: true,
  });
  const frame = decodeRequestFrame({
    requestId: 'configure-worktrees',
    operation: 'worktree.mutate',
    input: { kind: 'configure', config: { rootDirectory: '/custom/worktrees' } },
  });
  assert.equal(authorizeRuntimeHostOperation(remote, frame), false);
  assert.equal(authorizeRuntimeHostOperation(authorizedRemote, frame), true);
  assert.equal(authorizeRuntimeHostOperation(LOCAL_OWNER_CONNECTION_AUTHORITY, frame), true);
});

test('worktree configuration rejects project root overrides and invalid Host configuration', () => {
  const spec = HOST_OPERATION_SPECS['worktree.mutate'];
  for (const rootDirectory of ['/custom/worktrees', '']) {
    assert.throws(() =>
      spec.decodeInput({
        kind: 'configure',
        projectId: 'project',
        config: { rootDirectory },
      }),
    );
  }
  for (const config of [
    {},
    { setupScript: 'npm ci' },
    { rootDirectory: '' },
    { rootDirectory: 'relative/path' },
    { rootDirectory: '/custom/worktrees', setupScript: 'npm ci' },
  ]) {
    assert.throws(() => spec.decodeInput({ kind: 'configure', config }));
  }
});

test('project-scoped worktree operations remain available without Host-path authority', () => {
  const remote = createRuntimeHostConnectionAuthority({
    principalKind: 'remote_owner',
    principalId: 'remote-client',
    credentialId: 'remote-credential',
    operationGrants: REMOTE_OWNER_OPERATION_GRANTS,
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
  });
  for (const input of [
    { kind: 'configure', config: { setupScript: 'npm ci', cleanupScript: '', defaultMode: 'new' } },
    { kind: 'create', operationId: 'task', description: 'Add search' },
    { kind: 'create', operationId: 'fork', description: 'Fix search', sourcePath: '/repo/source' },
    { kind: 'initialize', path: '/repo/checkout', skip: true },
    { kind: 'remove', path: '/repo/checkout' },
    { kind: 'resolve_preparation', operationId: 'task', decision: 'cancel' },
  ]) {
    const frame = decodeRequestFrame({
      requestId: 'manage-project-worktree',
      operation: 'worktree.mutate',
      input: { ...input, projectId: 'project' },
    });
    assert.equal(authorizeRuntimeHostOperation(remote, frame), true, input.kind);
  }
});

test('session creation admits exactly one project checkout selection', () => {
  const base = { sessionId: 'task', modelTarget: { kind: 'default' } };
  for (const worktree of [
    { kind: 'main' },
    { kind: 'new' },
    { kind: 'existing', path: '/repo/checkout' },
  ]) {
    const request = { ...base, workspace: { kind: 'project', projectId: 'project', worktree } };
    assert.deepEqual(decodeSessionCreateInput(request), request);
  }
  for (const request of [
    { ...base, workspace: { kind: 'project', projectId: 'project', worktreePath: '/repo/a' } },
    {
      ...base,
      workspace: {
        kind: 'project',
        projectId: 'project',
        worktree: { kind: 'main' },
        worktreePath: '/repo/a',
      },
    },
    { ...base, workspace: { kind: 'project', projectId: 'project' }, worktree: { kind: 'new' } },
    { ...base, workspace: { kind: 'host_path', path: '/repo', worktree: { kind: 'new' } } },
  ])
    assert.throws(() => decodeSessionCreateInput(request));
});

test('session worktree capability has a strict Host-owned contract', () => {
  const operation = HOST_OPERATION_SPECS['worktree.session.query'];
  assert.deepEqual(operation.decodeInput({ sessionId: 'session' }), { sessionId: 'session' });
  assert.deepEqual(operation.decodeOutput({ path: '/repo', canCreate: true }), {
    path: '/repo',
    canCreate: true,
  });
  assert.throws(() => operation.decodeInput({ sessionId: 'session', canCreate: true }));
  assert.throws(() => operation.decodeOutput({ path: '/repo', canCreate: 'true' }));
});

test('preparation decisions validate their identity, action, and result', () => {
  const spec = HOST_OPERATION_SPECS['worktree.mutate'];
  for (const decision of ['main', 'cancel']) {
    const input = {
      kind: 'resolve_preparation',
      projectId: 'project',
      operationId: 'task',
      decision,
    };
    assert.deepEqual(spec.decodeInput(input), input);
  }
  assert.throws(() =>
    spec.decodeInput({
      kind: 'resolve_preparation',
      projectId: 'project',
      operationId: 'task',
      decision: 'delete',
    }),
  );
  assert.deepEqual(spec.decodeOutput({ kind: 'preparation_resolved' }), {
    kind: 'preparation_resolved',
  });
});

test('preparation projections reject ambiguous phases and missing paths', () => {
  const spec = HOST_OPERATION_SPECS['worktree.preparation.query'];
  assert.deepEqual(spec.decodeInput({ operationId: 'task' }), { operationId: 'task' });
  for (const phase of ['inactive', 'preparing'])
    assert.deepEqual(spec.decodeOutput({ phase }), { phase });
  for (const phase of ['checkout', 'initializing', 'finalizing', 'blocked']) {
    assert.deepEqual(spec.decodeOutput({ phase, path: '/checkout' }), { phase, path: '/checkout' });
    assert.throws(() => spec.decodeOutput({ phase }));
  }
  assert.throws(() => spec.decodeOutput({ phase: 'unknown' }));
  assert.throws(() => spec.decodeOutput({ phase: 'inactive', path: '/checkout' }));
});
