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
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SESSION_NAME_MAX_CODE_POINTS } from '@maka/core/session-name';
import type { RuntimeHostConnection } from '../client/index.js';
import type { SessionCatalogItem } from '../protocol/index.js';
import {
  connectClient,
  requireStartedTurn,
  waitForTerminalTurn,
  withExecutionRoot,
} from './fixtures/execution-host-suite.js';

const SOURCE_TURN_ID = 'branch-name-source-turn';

function session(projection: SessionCatalogItem) {
  assert.ok(!('reason' in projection), 'Expected a wire-representable Session');
  return projection;
}

async function read(client: RuntimeHostConnection, sessionId: string) {
  const result = await client.request('session.catalog.query', { kind: 'get', sessionId });
  assert.ok(result.kind === 'session' && result.session);
  return session(result.session);
}

async function rename(client: RuntimeHostConnection, sessionId: string, name: string) {
  const source = await read(client, sessionId);
  const result = await client.request('session.metadata.update', {
    sessionId,
    expectedRevision: source.revision,
    patch: { name },
  });
  assert.equal(result.kind, 'committed');
}

async function branch(
  client: RuntimeHostConnection,
  sourceSessionId: string,
  targetSessionId: string = randomUUID(),
  sourceTurnId = SOURCE_TURN_ID,
) {
  const source = await read(client, sourceSessionId);
  const result = await client.request('session.branch.create', {
    sourceSessionId,
    targetSessionId,
    sourceTurnId,
    expectedSourceRevision: source.revision,
  });
  assert.ok(result.kind === 'committed');
  return session(result.session);
}

async function settleSource(
  client: RuntimeHostConnection,
  sessionId: string,
  turnId = SOURCE_TURN_ID,
) {
  const turn = requireStartedTurn(
    await client.request('turn.start', {
      sessionId,
      turnId,
      content: { text: 'Answer briefly.' },
    }),
  );
  await waitForTerminalTurn(client, sessionId, turn.turnId);
}

test('ordinary branches keep distinct durable names without stacking suffixes', async () => {
  await withExecutionRoot(async (fixture) => {
    const collisionId = await fixture.seedSession();
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);
    try {
      await rename(client, fixture.sessionId, 'Review project');
      await settleSource(client, fixture.sessionId);
      await rename(client, collisionId, 'Review project (2)');
      await client.request('session.lifecycle.set', { sessionId: collisionId, state: 'archived' });
      const first = await branch(client, fixture.sessionId);
      const second = await branch(client, fixture.sessionId);
      const nested = await branch(client, first.id);
      assert.deepEqual(
        [first.name, second.name, nested.name],
        ['Review project (1)', 'Review project (3)', 'Review project (4)'],
      );
      assert.equal((await read(client, fixture.sessionId)).name, 'Review project');
      assert.equal(nested.parentSessionId, first.id);
      assert.deepEqual(await branch(client, fixture.sessionId, first.id), first);

      await settleSource(client, first.id, 'branch-second-turn');
      const edit = await client.request('session.revision.create', {
        sourceSessionId: first.id,
        targetSessionId: randomUUID(),
        sourceTurnId: 'branch-second-turn',
        expectedSourceRevision: (await read(client, first.id)).revision,
      });
      assert.ok(edit.kind === 'committed');
      const edited = session(edit.session);
      assert.equal(edited.name, first.name);
      assert.equal((await branch(client, edited.id)).name, 'Review project (5)');

      await rename(client, first.id, 'New focus (2026)');
      assert.equal((await branch(client, first.id)).name, 'New focus (2026) (1)');
      assert.equal((await branch(client, fixture.sessionId, first.id)).name, 'New focus (2026)');

      await rename(client, fixture.sessionId, 'Sprint (2026)');
      const numbered = await branch(client, fixture.sessionId);
      assert.equal(numbered.name, 'Sprint (2026) (1)');
      assert.equal((await branch(client, numbered.id)).name, 'Sprint (2026) (2)');

      await fixture.stopHost(host);
      await fixture.startHost();
      const restarted = await connectClient(fixture.root);
      try {
        assert.equal((await read(restarted, second.id)).name, second.name);
        assert.equal((await branch(restarted, numbered.id)).name, 'Sprint (2026) (3)');
      } finally {
        await restarted.close();
      }
    } finally {
      await client.close();
    }
  });
});

test('concurrent branches from different sources reserve unique code-point-bounded names', async () => {
  await withExecutionRoot(async (fixture) => {
    const otherSourceId = await fixture.seedSession();
    await fixture.startHost();
    const desktop = await connectClient(fixture.root);
    const tui = await connectClient(fixture.root);
    try {
      const name = '😀'.repeat(SESSION_NAME_MAX_CODE_POINTS);
      await rename(desktop, fixture.sessionId, name);
      await rename(tui, otherSourceId, name);
      await settleSource(desktop, fixture.sessionId);
      await settleSource(tui, otherSourceId, 'other-source-turn');
      const branches = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          branch(
            index % 2 === 0 ? desktop : tui,
            index % 2 === 0 ? fixture.sessionId : otherSourceId,
            undefined,
            index % 2 === 0 ? SOURCE_TURN_ID : 'other-source-turn',
          ),
        ),
      );
      assert.equal(new Set(branches.map(({ name }) => name)).size, branches.length);
      for (let index = 1; index <= branches.length; index += 1) {
        const suffix = ` (${index})`;
        const expected = '😀'.repeat(SESSION_NAME_MAX_CODE_POINTS - suffix.length) + suffix;
        assert.ok(
          branches.some(({ name }) => name === expected),
          `Missing ${suffix}`,
        );
      }
      for (const created of branches) {
        assert.equal(Array.from(created.name).length, SESSION_NAME_MAX_CODE_POINTS);
        assert.equal((await read(tui, created.id)).name, created.name);
      }
      assert.equal((await read(desktop, fixture.sessionId)).name, name);
      assert.equal((await read(tui, otherSourceId)).name, name);
    } finally {
      await Promise.all([desktop.close(), tui.close()]);
    }
  });
});
