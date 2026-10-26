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
import { test, type TestContext } from 'node:test';
import type { WorktreeSnapshot } from '@maka/core/worktree';
import {
  HOST_OPERATION_SPECS,
  decodeHostFrame,
  decodeRequestFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  WORKTREE_PAGE_MAX_BYTES,
  type WorktreeQueryInput,
  type WorktreeQueryResult,
} from '../protocol/index.js';
import { readRuntimeHostWorktrees } from '../client/catalog-reader.js';
import { createWorktreeHandlers } from '../server/worktree-handlers.js';
import { fixture } from './worktree-fixture.js';

const caller = {
  hostEpoch: 'test-epoch',
  connectionId: 'test-client',
  principal: 'local_owner',
  acquireResidency: () => ({ release() {} }),
};

function largeSnapshot(): WorktreeSnapshot {
  return {
    config: { rootDirectory: '/worktrees', projects: {} },
    projects: [
      {
        id: 'project',
        name: 'Example',
        mainPath: '/repo',
        config: {},
        worktrees: Array.from({ length: 33 }, (_, index) => ({
          projectId: 'project',
          path: `/worktrees/task-${index}`,
          name: `task-${index}`,
          head: 'a'.repeat(40),
          isMain: false,
          managed: true,
          available: true,
          locked: false,
          sessionCount: 1,
          initialization: 'failed',
          log: 'x'.repeat(24_000),
        })),
      },
    ],
  };
}

async function wireReader(t: TestContext, readSnapshot: () => WorktreeSnapshot) {
  const { manager } = await fixture(t);
  t.mock.method(manager, 'snapshot', async () => readSnapshot());
  const handlers = createWorktreeHandlers(manager, async () => {
    throw new Error('unused');
  });
  const requests: WorktreeQueryInput[] = [];
  const connection = {
    async request(
      operation: 'worktree.query',
      input: WorktreeQueryInput,
    ): Promise<WorktreeQueryResult> {
      requests.push(input);
      decodeRequestFrame({ requestId: 'query', operation, input });
      const outcome = await handlers[operation](input, caller);
      assert.ok(outcome.ok, JSON.stringify(outcome));
      const frame = { requestId: 'query', operation, ...outcome };
      // Exercise the same strict decode and encoding limit as the real transport.
      const encoded = encodeProtocolMessage(frame);
      assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES);
      const decoded = decodeHostFrame(JSON.parse(encoded.toString('utf8')));
      assert.ok('operation' in decoded && decoded.operation === operation && decoded.ok);
      assert.ok(Buffer.byteLength(JSON.stringify(decoded.result)) <= WORKTREE_PAGE_MAX_BYTES);
      return decoded.result;
    },
  };
  return { connection, requests, handlers };
}

for (const content of ['x', '中文😀\n\"\\\u0000']) {
  test(`worktree queries retain all setup logs across bounded wire pages (${JSON.stringify(content)})`, async (t) => {
    const snapshot = largeSnapshot();
    const failure = '\nsetup failed';
    for (const worktree of snapshot.projects[0]!.worktrees)
      worktree.log = content.repeat(24_000).slice(0, 24_000 - failure.length) + failure;
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > RUNTIME_HOST_MAX_MESSAGE_BYTES);
    const { connection, requests } = await wireReader(t, () => snapshot);
    assert.deepEqual(await readRuntimeHostWorktrees(connection, 'project'), snapshot);
    assert.ok(requests.length > 1, 'large logs must cross a page boundary');
    assert.ok(requests.every((input) => input.projectId === 'project'));
  });
}

test('worktree pages also bound project configuration maps and preserve empty projects', async (t) => {
  const snapshot: WorktreeSnapshot = {
    config: { rootDirectory: '/worktrees', projects: {} },
    projects: [],
  };
  for (let index = 0; index < 140; index++) {
    const id = `project-${index}`;
    const config =
      index < 12 ? { setupScript: '\n"'.repeat(16_000), cleanupScript: '\t'.repeat(32_000) } : {};
    snapshot.config.projects[id] = config;
    snapshot.projects.push({ id, name: id, mainPath: `/repos/${id}`, config, worktrees: [] });
  }
  // Configurations of archived/unavailable projects must survive aggregation too.
  snapshot.config.projects['archived-project'] = { setupScript: 'echo retained' };
  const { connection, requests } = await wireReader(t, () => snapshot);
  assert.deepEqual(await readRuntimeHostWorktrees(connection), snapshot);
  assert.ok(requests.length > 2);
});

test('worktree readers discard partial pages when logs or membership change', async (t) => {
  const before = largeSnapshot();
  const after = structuredClone(before);
  after.projects[0]!.worktrees.shift();
  after.projects[0]!.worktrees[0]!.log = 'new initialization result';
  after.config.rootDirectory = '/new-worktrees';
  let reads = 0;
  const { connection, requests } = await wireReader(t, () => (++reads === 1 ? before : after));
  assert.deepEqual(await readRuntimeHostWorktrees(connection), after);
  assert.equal(requests.filter((input) => input.cursor === undefined).length, 2);
});

test('empty worktree catalogs finish in one page', async (t) => {
  const snapshot: WorktreeSnapshot = {
    config: { rootDirectory: '/worktrees', projects: {} },
    projects: [],
  };
  const { connection, requests } = await wireReader(t, () => snapshot);
  assert.deepEqual(await readRuntimeHostWorktrees(connection), snapshot);
  assert.equal(requests.length, 1);
});

test('worktree pagination rejects malformed and out-of-range continuations', async (t) => {
  const spec = HOST_OPERATION_SPECS['worktree.query'];
  const revision = `sha256:${'a'.repeat(64)}`;
  for (const input of [
    { cursor: '1' },
    { revision },
    { revision: 'invalid', cursor: '1' },
    ...['0', '-1', '1.5', '01', '1e2', '9007199254740992'].map((cursor) => ({ revision, cursor })),
  ])
    assert.throws(() => spec.decodeInput(input));
  const { handlers } = await wireReader(t, largeSnapshot);
  const first = await handlers['worktree.query']({}, caller);
  assert.ok(first.ok && first.result.kind === 'page');
  const invalid = await handlers['worktree.query'](
    { revision: first.result.revision, cursor: '9999' },
    caller,
  );
  assert.ok(!invalid.ok);
  assert.equal(invalid.error.code, 'invalid_request');
});

test('worktree page decoding rejects unbounded lists before they reach the writer', () => {
  const page = {
    kind: 'page',
    revision: `sha256:${'a'.repeat(64)}`,
    rootDirectory: '/worktrees',
    nextCursor: null,
    items: largeSnapshot().projects[0]!.worktrees.map((worktree) => ({
      kind: 'worktree',
      worktree,
    })),
  };
  assert.throws(() => HOST_OPERATION_SPECS['worktree.query'].decodeOutput(page));
});
