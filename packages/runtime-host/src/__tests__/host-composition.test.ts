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
  beginRuntimeHostDomainModuleDrain,
  closeRuntimeHostDomainModules,
  composeRuntimeHostDomainHandlers,
  createRuntimeHostDomainModule,
  normalizeHostCompositionDescriptor,
  type RuntimeHostDomainModule,
} from '../server/host-composition.js';

test('Host composition descriptors reject ambiguous identities', () => {
  for (const descriptor of [
    { id: 'Interactive', revision: '1' },
    { id: 'maka.interactive', revision: '' },
  ]) {
    assert.throws(() => normalizeHostCompositionDescriptor(descriptor), TypeError);
  }
});

test('a Domain Module owns its handlers and lifecycle resources', async () => {
  const events: string[] = [];
  const module = createRuntimeHostDomainModule({
    id: 'execution',
    handlers: [
      {
        'goal.query': async () => ({ ok: false, error: unavailableOperation() }),
      },
    ],
    recovery: {
      executions: () => {
        events.push('recover');
      },
    },
    drain: [() => events.push('drain')],
    close: [
      () => {
        events.push('close');
      },
    ],
    releaseConnection: [(connectionId) => events.push(`release:${connectionId}`)],
  });

  assert.equal(typeof module.handlers['goal.query'], 'function');
  await module.recover('executions');
  module.releaseConnection?.('connection-1');
  module.beginDrain();
  await module.close();
  assert.deepEqual(events, ['recover', 'release:connection-1', 'drain', 'close']);
});

test('Domain Module handlers have one explicit owner', () => {
  const events: string[] = [];
  const first = domainModule('first', events, {
    'goal.query': async () => ({ ok: false, error: unavailableOperation() }),
  });
  const second = domainModule('second', events, {
    'goal.query': async () => ({ ok: false, error: unavailableOperation() }),
  });

  const handlers = composeRuntimeHostDomainHandlers([first]);
  assert.equal(typeof handlers['goal.query'], 'function');
  assert.throws(
    () => composeRuntimeHostDomainHandlers([first, second]),
    /Duplicate Runtime Host operation handler: goal\.query/u,
  );
});

test('Domain Module close attempts every owner and aggregates failures', async () => {
  const events: string[] = [];
  const first = domainModule('first', events);
  const second = domainModule('second', events);
  first.close = async () => {
    events.push('first:close');
    throw new Error('first failed');
  };
  second.close = async () => {
    events.push('second:close');
    throw new Error('second failed');
  };

  await assert.rejects(
    closeRuntimeHostDomainModules([first, second]),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.every((item) => item instanceof Error),
  );
  assert.deepEqual(events, ['second:close', 'first:close']);
});

test('Domain Module drain fences every owner and reports failures during close', async () => {
  const events: string[] = [];
  const first = domainModule('first', events);
  const second = domainModule('second', events);
  first.beginDrain = () => {
    events.push('first:drain');
  };
  second.beginDrain = () => {
    events.push('second:drain');
    throw new Error('second drain failed');
  };

  beginRuntimeHostDomainModuleDrain([first, second]);
  assert.deepEqual(events, ['second:drain', 'first:drain']);
  await assert.rejects(
    closeRuntimeHostDomainModules([first, second]),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] instanceof Error &&
      error.errors[0].message === 'second drain failed',
  );
  assert.deepEqual(events, ['second:drain', 'first:drain', 'second:close', 'first:close']);
});

function domainModule(
  id: string,
  events: string[],
  handlers: RuntimeHostDomainModule['handlers'] = {},
): RuntimeHostDomainModule {
  return {
    id,
    handlers,
    async recover(phase) {
      events.push(`${id}:recover:${phase}`);
    },
    beginDrain() {
      events.push(`${id}:drain`);
    },
    async close() {
      events.push(`${id}:close`);
    },
  };
}

function unavailableOperation() {
  return {
    code: 'operation_unavailable' as const,
    message: 'Unavailable in test composition',
  };
}
