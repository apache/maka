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
import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';
import type { RuntimeHostConnection } from '../client/index.js';
import {
  connectClient,
  PROCESS_TIMEOUT_MS,
  requireStartedTurn,
  waitForTerminalTurn,
  withExecutionRoot,
} from './fixtures/execution-host-suite.js';

// The Session title effect runs after the Run starts and writes out of band, so
// the name lands after the Turn is already terminal. Without a reachable title
// model the effect falls back to the Message's first line, which is what makes
// this assertion independent of any provider.
async function readSession(client: RuntimeHostConnection, sessionId: string) {
  const result = await client.request('session.catalog.query', { kind: 'get', sessionId });
  assert.equal(result.kind, 'session');
  if (result.kind !== 'session') assert.fail('Expected a Session projection');
  const session = result.session;
  assert.ok(session && !('reason' in session), 'Expected a wire-representable Session');
  if (!session || 'reason' in session) assert.fail('Expected a wire-representable Session');
  return session;
}

async function waitForGeneratedName(
  client: RuntimeHostConnection,
  sessionId: string,
): Promise<string> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let name = DEFAULT_SESSION_NAME;
  while (Date.now() < deadline) {
    name = (await readSession(client, sessionId)).name;
    if (name !== DEFAULT_SESSION_NAME) return name;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return name;
}

test('a submitted first Message names its default-named Session', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);

    const submitted = await client.request('turn.message.submit', {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      messageId: randomUUID(),
      placement: 'current_turn',
      content: { text: 'draft the release notes' },
    });
    assert.equal(submitted.disposition, 'turn_started');
    if (submitted.disposition !== 'turn_started') assert.fail('Expected a started Turn');
    await waitForTerminalTurn(client, fixture.sessionId, submitted.turnId);

    assert.equal(await waitForGeneratedName(client, fixture.sessionId), 'draft the release notes');
    // The first user Message is also what freezes the Session's route; no Run
    // writes that fact separately.
    assert.equal((await readSession(client, fixture.sessionId)).connectionLocked, true);
  });
});

test('a started first Turn names its default-named Session', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.startHost();
    const client = await connectClient(fixture.root);

    const turnId = randomUUID();
    requireStartedTurn(
      await client.request('turn.start', {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'draft the release notes' },
      }),
    );
    await waitForTerminalTurn(client, fixture.sessionId, turnId);

    assert.equal(await waitForGeneratedName(client, fixture.sessionId), 'draft the release notes');
    assert.equal((await readSession(client, fixture.sessionId)).connectionLocked, true);
  });
});
