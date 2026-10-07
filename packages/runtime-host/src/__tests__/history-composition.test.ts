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
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import { subscribeRuntimeHostHistoryChanges } from '../server/history-composition.js';

type SubscriptionsInput = Parameters<typeof subscribeRuntimeHostHistoryChanges>[0];

function subscriptionFixture() {
  const listeners: Record<string, (sessionId: string) => void> = {};
  const events: string[] = [];
  const subscribe = (kind: string) => (listener: (sessionId: string) => void) => {
    listeners[kind] = listener;
    return () => {
      events.push(`release:${kind}`);
    };
  };
  const input: SubscriptionsInput = {
    stores: {
      sessionStore: { subscribeTranscriptChanges: subscribe('transcript') },
      runtimeEventStore: { subscribeRuntimeEventCommits: subscribe('runtime') },
    } as unknown as Pick<
      ExecutionStoresWriter<'interactive'>,
      'sessionStore' | 'runtimeEventStore'
    >,
    usage: { subscribeSessionUsageChanges: subscribe('usage') },
    continuity: {
      enqueueCanonicalRefresh: (id) => {
        events.push(`refresh:${id}`);
      },
      enqueueTranscriptAdvanced: (id) => {
        events.push(`advance:${id}`);
      },
      enqueueSessionDomainChanged: (id, domain) => {
        events.push(`${domain}:${id}`);
      },
    },
    onTranscriptChanged: (id) => {
      events.push(`notify:${id}`);
    },
    onRuntimeEventCommitted: (id) => {
      events.push(`reconcile:${id}`);
    },
  };
  return { input, listeners, events };
}

test('history subscriptions preserve canonical refresh, event advancement and downstream notifications', () => {
  const { input, listeners, events } = subscriptionFixture();
  const subscriptions = subscribeRuntimeHostHistoryChanges(input);
  listeners.transcript('s1');
  listeners.runtime('s2');
  listeners.usage('s3');
  assert.deepEqual(events, ['refresh:s1', 'notify:s1', 'advance:s2', 'reconcile:s2', 'usage:s3']);
  subscriptions.close();
  subscriptions.close();
  assert.deepEqual(events.slice(5), ['release:transcript', 'release:runtime', 'release:usage']);
});

test('history composition releases both earlier subscriptions when usage binding fails', () => {
  const { input, events } = subscriptionFixture();
  input.usage.subscribeSessionUsageChanges = () => {
    throw new Error('usage subscription failed');
  };
  assert.throws(() => subscribeRuntimeHostHistoryChanges(input), /usage subscription failed/);
  assert.deepEqual(events, ['release:transcript', 'release:runtime']);
});

test('history composition attempts every release and preserves the binding failure', () => {
  const { input, events } = subscriptionFixture();
  const bindingFailure = new Error('usage subscription failed');
  const releaseFailure = new Error('transcript release failed');
  input.usage.subscribeSessionUsageChanges = () => {
    throw bindingFailure;
  };
  assert.throws(
    () =>
      subscribeRuntimeHostHistoryChanges({
        ...input,
        stores: {
          ...input.stores,
          sessionStore: {
            ...input.stores.sessionStore,
            subscribeTranscriptChanges: () => () => {
              throw releaseFailure;
            },
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [bindingFailure, releaseFailure]);
      return true;
    },
  );
  assert.deepEqual(events, ['release:runtime']);
});
