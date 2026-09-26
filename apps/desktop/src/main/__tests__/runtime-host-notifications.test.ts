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
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { deferred, waitFor } from '@maka/core/test-only/async-primitives';
import type { RuntimeHostConnection, RuntimeHostConnectionAvailability } from '@maka/runtime-host/client';
import type { SessionCatalogChangedFrame } from '@maka/runtime-host/protocol';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import type { RunNotificationInput } from '../notifications-policy.js';
import { observeRuntimeHostNotifications } from '../runtime-host-notifications.js';

test('notifies for every session through the Host feed without renderer or transcript subscriptions', async (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(f.operations, ['session.attention.subscribe']);
  f.changed({ kind: 'session.catalog.changed', revision: 1, sessionId: 'old' });
  for (const [sessionId, kind, body] of [
    ['background-question', 'waiting', 'Which branch?'],
    ['background-complete', 'completed', undefined],
    ['background-failed', 'errored', 'provider failed'],
  ] as const) {
    f.changed({
      kind: 'session.catalog.changed', revision: 2, sessionId,
      attention: { kind, eventId: sessionId, ...(body ? { body } : {}) },
    });
  }
  await waitFor(() => f.notifications.length === 3, { timeoutMs: 1000 });
  assert.deepEqual(f.notifications, [
    { kind: 'waiting', title: 'background-question', body: 'Which branch?' },
    { kind: 'completed', title: 'background-complete', body: 'reply-background-complete' },
    { kind: 'errored', title: 'background-failed', body: 'provider failed' },
  ]);
  assert.deepEqual(f.errors, []);
});

test('re-enables the feed after reconnect and discards in-flight notification content after disposal', async () => {
  const f = fixture(false, false);
  assert.deepEqual(f.operations, []);
  f.availability({ kind: 'connected', hostEpoch: 'host-1', connectionId: 'connection-1' });
  const content = deferred<null>();
  f.client.getSession = () => content.promise;
  f.changed({
    kind: 'session.catalog.changed', revision: 1, sessionId: 'a',
    attention: { kind: 'completed', eventId: 'done' },
  });
  f.availability({ kind: 'unavailable' });
  f.availability({ kind: 'connected', hostEpoch: 'host-2', connectionId: 'connection-2' });
  assert.equal(f.operations.filter((operation) => operation === 'session.attention.subscribe').length, 2);
  f.close();
  content.resolve(null);
  await setImmediate();
  assert.deepEqual(f.notifications, []);
  assert.equal(f.listenersRemaining(), 0);
});

test('shared sessions use the scoped catalog and content-read failures still notify with fallback copy', async (t) => {
  const f = fixture(true);
  t.after(f.close);
  f.client.getSession = async () => { throw new Error('Owner-only query must not be used'); };
  f.client.getSharedSession = async () => { throw new Error('Host disconnected'); };
  f.changed({
    kind: 'session.catalog.changed', revision: 1, sessionId: 'shared',
    attention: { kind: 'waiting', eventId: 'question', body: 'Answer?' },
  });
  await waitFor(() => f.notifications.length === 1, { timeoutMs: 1000 });
  assert.deepEqual(f.notifications, [{ kind: 'waiting', title: undefined, body: 'Answer?' }]);
});

function fixture(shared = false, initiallyConnected = true) {
  let listener: ((frame: SessionCatalogChangedFrame) => void) | undefined;
  let availability: ((value: RuntimeHostConnectionAvailability) => void) | undefined;
  const notifications: RunNotificationInput[] = [];
  const errors: unknown[] = [];
  const operations: string[] = [];
  const connection = {
    reconnecting: true,
    request: async (operation: string, input: { sessionId?: string }) => {
      operations.push(operation);
      if (operation === 'session.attention.subscribe') return { subscribed: true };
      return { kind: 'session', session: { id: input.sessionId, name: input.sessionId, lastMessagePreview: 'reply-' + input.sessionId } };
    },
    subscribeSessionCatalogChanges(next: typeof listener) {
      listener = next;
      return () => { listener = undefined; };
    },
    subscribeConnectionAvailability(next: typeof availability) {
      availability = next;
      next?.(initiallyConnected ? { kind: 'connected', hostEpoch: 'host-1', connectionId: 'connection-1' } : { kind: 'unavailable' });
      return () => { availability = undefined; };
    },
  } as unknown as RuntimeHostConnection;
  const client = new DesktopRuntimeHostClient(connection);
  const close = observeRuntimeHostNotifications(client, async (input) => { notifications.push(input); }, (error) => errors.push(error), shared);
  return {
    client, close, operations, notifications, errors,
    changed(frame: SessionCatalogChangedFrame) { listener?.(frame); },
    availability(value: RuntimeHostConnectionAvailability) { availability?.(value); },
    listenersRemaining: () => Number(!!listener) + Number(!!availability),
  };
}
