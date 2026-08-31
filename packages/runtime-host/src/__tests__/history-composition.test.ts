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
import type { TaskLedgerChangedEvent } from '@maka/core/task-ledger';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
import { subscribeRuntimeHostHistoryChanges } from '../server/history-composition.js';
import type { SessionContinuityCoordinator } from '../server/session-continuity-coordinator.js';
import type { HostTaskLedgerCoordinator } from '../server/task-ledger-coordinator.js';

test('history subscriptions route durable changes and release exactly once', () => {
  let transcriptListener: ((sessionId: string) => void) | undefined;
  let usageListener: ((sessionId: string) => void) | undefined;
  let taskListener: ((event: TaskLedgerChangedEvent) => void) | undefined;
  const released: string[] = [];
  const refreshes: string[] = [];
  const domains: Array<[string, string]> = [];

  const subscriptions = subscribeRuntimeHostHistoryChanges({
    stores: {
      sessionStore: {
        subscribeTranscriptChanges(listener: (sessionId: string) => void) {
          transcriptListener = listener;
          return () => released.push('transcript');
        },
      },
    } as unknown as Pick<ExecutionStoresWriter<'interactive'>, 'sessionStore'>,
    usage: {
      subscribeSessionUsageChanges(listener) {
        usageListener = listener;
        return () => released.push('usage');
      },
    } as Pick<InteractiveUsageStoresWriter, 'subscribeSessionUsageChanges'>,
    taskLedger: {
      subscribe(listener) {
        taskListener = listener;
        return () => released.push('task');
      },
    } as Pick<HostTaskLedgerCoordinator, 'subscribe'>,
    continuity: {
      enqueueCanonicalRefresh(sessionId) {
        refreshes.push(sessionId);
      },
      enqueueSessionDomainChanged(sessionId, domain) {
        domains.push([sessionId, domain]);
      },
    } as Pick<
      SessionContinuityCoordinator,
      'enqueueCanonicalRefresh' | 'enqueueSessionDomainChanged'
    >,
  });

  transcriptListener?.('session-transcript');
  usageListener?.('session-usage');
  taskListener?.({ sessionId: 'session-task' } as TaskLedgerChangedEvent);
  assert.deepEqual(refreshes, ['session-transcript']);
  assert.deepEqual(domains, [
    ['session-usage', 'usage'],
    ['session-task', 'task'],
  ]);

  subscriptions.close();
  subscriptions.close();
  assert.deepEqual(released, ['transcript', 'usage', 'task']);
});

test('history composition releases earlier subscriptions when binding fails', () => {
  const released: string[] = [];
  assert.throws(
    () =>
      subscribeRuntimeHostHistoryChanges({
        stores: {
          sessionStore: {
            subscribeTranscriptChanges() {
              return () => released.push('transcript');
            },
          },
        } as unknown as Pick<ExecutionStoresWriter<'interactive'>, 'sessionStore'>,
        usage: {
          subscribeSessionUsageChanges() {
            throw new Error('usage subscription failed');
          },
        } as Pick<InteractiveUsageStoresWriter, 'subscribeSessionUsageChanges'>,
        taskLedger: {} as Pick<HostTaskLedgerCoordinator, 'subscribe'>,
        continuity: {} as Pick<
          SessionContinuityCoordinator,
          'enqueueCanonicalRefresh' | 'enqueueSessionDomainChanged'
        >,
      }),
    /usage subscription failed/,
  );
  assert.deepEqual(released, ['transcript']);
});
