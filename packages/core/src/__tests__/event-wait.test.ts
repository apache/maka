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
  assertEventWaitTransition,
  decodeEventWaitRecord,
  eventWaitDeliveryKey,
  EVENT_WAIT_LIMITS,
  type EventWaitRecord,
} from '../event-wait.js';

function waiting(): Extract<EventWaitRecord, { status: 'waiting' }> {
  return {
    schemaVersion: 1,
    waitId: 'wait_1',
    sessionId: 'session_1',
    goalControlLease: { goalId: 'goal_1', generation: 0 },
    sourceTurnId: 'turn_1',
    sourceToolCallId: 'call:1',
    resource: {
      providerId: 'test.provider',
      connectionId: null,
      resourceType: 'task',
      resourceId: 'opaque/任务',
    },
    condition: { typeId: 'terminal', version: 1, parameters: { n: 1, nested: [null, true, 'x'] } },
    deliveryKey: 'event-wait/wait_1',
    createdAt: 10,
    updatedAt: 10,
    deadlineAt: 100,
    status: 'waiting',
  };
}

const result = {
  outcome: 'satisfied',
  receiptKey: 'receipt-1',
  observedAt: 20,
  evidenceRefs: ['maka://evidence/1'],
} as const;
const resolved = (): Extract<EventWaitRecord, { status: 'resolved' }> => ({
  ...waiting(),
  status: 'resolved',
  updatedAt: 30,
  resolvedAt: 25,
  resolution: result,
});
const cancelled = (): Extract<EventWaitRecord, { status: 'cancelled' }> => ({
  ...waiting(),
  status: 'cancelled',
  updatedAt: 30,
  cancelledAt: 30,
  reason: 'revoked',
});
const expired = (): Extract<EventWaitRecord, { status: 'expired' }> => ({
  ...waiting(),
  status: 'expired',
  updatedAt: 100,
  expiredAt: 100,
});

test('bounded v1 records decode into isolated deterministic JSON; identity is correlation, not authorization', () => {
  for (const record of [
    waiting(),
    resolved(),
    cancelled(),
    expired(),
    { ...cancelled(), priorResolution: { resolvedAt: 25, resolution: result } },
  ]) {
    assert.deepEqual(decodeEventWaitRecord(record), record);
    assert.notEqual(
      decodeEventWaitRecord(record).condition.parameters,
      record.condition.parameters,
    );
  }
  assert.equal(eventWaitDeliveryKey('wait_1'), waiting().deliveryKey);
  assert.throws(() => eventWaitDeliveryKey('../x'));
  const withNegativeZero = {
    ...waiting(),
    condition: { ...waiting().condition, parameters: { zero: -0 } },
  };
  assert.equal(
    Object.is(decodeEventWaitRecord(withNegativeZero).condition.parameters.zero, -0),
    false,
  );
});

for (const [name, patch] of Object.entries({
  version: { schemaVersion: 2 },
  unknown: { userAuthorized: true },
  missing: { resource: undefined },
  waitId: { waitId: '..' },
  sessionId: { sessionId: '' },
  turn: { sourceTurnId: 'a/b' },
  goal: { goalControlLease: { goalId: 'goal', generation: -1 } },
  leaseExtra: { goalControlLease: { goalId: 'goal', generation: 0, authorized: true } },
  generation: { goalControlLease: { goalId: 'goal', generation: 0.5 } },
  deadline: { deadlineAt: 10 },
  negative: { createdAt: -1 },
  fractional: { updatedAt: 10.5 },
  unsafe: { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
  backwards: { updatedAt: 9 },
  deliveryKey: { deliveryKey: 'tampered' },
  call: { sourceToolCallId: 'a'.repeat(513) },
  reason: { ...cancelled(), reason: '' },
  expiredEarly: { ...expired(), expiredAt: 99 },
  resolvedEarly: { ...resolved(), resolvedAt: 9 },
  observedLate: { ...resolved(), resolution: { ...result, observedAt: 26 } },
  terminalExtra: { resolvedAt: 20 },
  malformedStatus: { status: 'delivered' },
}))
  test(`rejects invalid record: ${name}`, () =>
    assert.throws(() => decodeEventWaitRecord({ ...waiting(), ...patch })));

test('ASCII identifiers use their full strings and exported bounds', () => {
  const validId = 'x'.repeat(EVENT_WAIT_LIMITS.idBytes);
  const validType = 'x'.repeat(EVENT_WAIT_LIMITS.typeIdBytes);
  decodeEventWaitRecord({
    ...waiting(),
    waitId: validId,
    sessionId: validId,
    goalControlLease: { goalId: validId, generation: Number.MAX_SAFE_INTEGER },
    sourceTurnId: validId,
    deliveryKey: eventWaitDeliveryKey(validId),
    resource: {
      ...waiting().resource,
      providerId: validType,
      connectionId: validId,
      resourceType: validType,
    },
    condition: { ...waiting().condition, typeId: validType, version: Number.MAX_SAFE_INTEGER },
  });
  for (const value of ['', 'x\n', 'x\r', 'x\t', '任务', 'x'.repeat(129)]) {
    assert.throws(() => eventWaitDeliveryKey(value), TypeError);
    for (const patch of [
      { waitId: value, deliveryKey: `event-wait/${value}` },
      { sessionId: value },
      { goalControlLease: { goalId: value, generation: 0 } },
      { sourceTurnId: value },
      { resource: { ...waiting().resource, connectionId: value } },
      { resource: { ...waiting().resource, providerId: value } },
      { resource: { ...waiting().resource, resourceType: value } },
      { condition: { ...waiting().condition, typeId: value } },
    ])
      assert.throws(() => decodeEventWaitRecord({ ...waiting(), ...patch }), TypeError);
  }
});

test('fixed shapes require every field and reject extensions at every level', () => {
  const record = waiting();
  for (const key of Object.keys(record)) {
    const missing: Record<string, unknown> = { ...record };
    delete missing[key];
    assert.throws(() => decodeEventWaitRecord(missing), TypeError);
  }
  for (const field of ['goalControlLease', 'resource', 'condition'] as const) {
    for (const key of Object.keys(record[field])) {
      const missing: Record<string, unknown> = { ...record[field] };
      delete missing[key];
      assert.throws(() => decodeEventWaitRecord({ ...record, [field]: missing }), TypeError);
    }
    assert.throws(
      () => decodeEventWaitRecord({ ...record, [field]: { ...record[field], extra: true } }),
      TypeError,
    );
  }
  for (const key of Object.keys(result)) {
    const missing: Record<string, unknown> = { ...result };
    delete missing[key];
    assert.throws(() => decodeEventWaitRecord({ ...resolved(), resolution: missing }), TypeError);
  }
  for (const priorResolution of [
    { resolvedAt: 25 },
    { resolution: result },
    { resolvedAt: 25, resolution: result, extra: true },
    { resolvedAt: 25, resolution: { ...result, extra: true } },
  ])
    assert.throws(() => decodeEventWaitRecord({ ...cancelled(), priorResolution }), TypeError);
  for (const record of [
    { ...resolved(), cancelledAt: 30 },
    { ...cancelled(), resolution: result },
    { ...expired(), priorResolution: { resolvedAt: 25, resolution: result } },
  ])
    assert.throws(() => decodeEventWaitRecord(record), TypeError);
});

test('rejects malformed fixed objects and bounded text/evidence', () => {
  for (const resource of [
    { ...waiting().resource, extra: true },
    { ...waiting().resource, providerId: 'a/b' },
    { ...waiting().resource, resourceId: '\0secret' },
    { ...waiting().resource, resourceId: 'a'.repeat(2049) },
    { ...waiting().resource, connectionId: 'x'.repeat(129) },
    { ...waiting().resource, resourceId: '\ud800' },
  ])
    assert.throws(() => decodeEventWaitRecord({ ...waiting(), resource }));
  for (const version of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() =>
      decodeEventWaitRecord({ ...waiting(), condition: { ...waiting().condition, version } }),
    );
  for (const resolution of [
    { ...result, outcome: 'unknown' },
    { ...result, extra: true },
    { ...result, receiptKey: 'x'.repeat(513) },
    { ...result, evidenceRefs: Array(9).fill('x') },
    { ...result, evidenceRefs: ['x'.repeat(1025)] },
  ])
    assert.throws(() => decodeEventWaitRecord({ ...resolved(), resolution }));
  assert.throws(() => decodeEventWaitRecord({ ...cancelled(), reason: 'a'.repeat(1025) }));
});

test('opaque text limits count UTF-8 bytes while allowing complete Unicode code points', () => {
  const resourceId = '🚀'.repeat(EVENT_WAIT_LIMITS.resourceIdBytes / 4);
  const sourceToolCallId = 'é'.repeat(EVENT_WAIT_LIMITS.toolCallIdBytes / 2);
  const receiptKey = 'é'.repeat(EVENT_WAIT_LIMITS.receiptKeyBytes / 2);
  const evidenceRef = '🚀'.repeat(EVENT_WAIT_LIMITS.evidenceRefBytes / 4);
  const reason = 'é'.repeat(EVENT_WAIT_LIMITS.reasonBytes / 2);
  decodeEventWaitRecord({
    ...resolved(),
    sourceToolCallId,
    resource: { ...waiting().resource, resourceId },
    resolution: { ...result, receiptKey, evidenceRefs: Array(8).fill(evidenceRef) },
  });
  decodeEventWaitRecord({ ...cancelled(), reason });
  for (const record of [
    { ...waiting(), resource: { ...waiting().resource, resourceId: `${resourceId}x` } },
    { ...waiting(), sourceToolCallId: `${sourceToolCallId}x` },
    { ...resolved(), resolution: { ...result, receiptKey: `${receiptKey}x` } },
    { ...resolved(), resolution: { ...result, evidenceRefs: [`${evidenceRef}x`] } },
    { ...cancelled(), reason: `${reason}x` },
  ])
    assert.throws(() => decodeEventWaitRecord(record), TypeError);
  for (const invalidText of ['\0', '\u001f', '\u007f', '\u009f', '\ud800', '\udfff']) {
    for (const record of [
      { ...waiting(), resource: { ...waiting().resource, resourceId: invalidText } },
      { ...waiting(), sourceToolCallId: invalidText },
      { ...resolved(), resolution: { ...result, receiptKey: invalidText } },
      { ...resolved(), resolution: { ...result, evidenceRefs: [invalidText] } },
      { ...cancelled(), reason: invalidText },
    ])
      assert.throws(() => decodeEventWaitRecord(record), TypeError);
  }
});

test('lifecycle times stay ordered and inside the record lifetime', () => {
  for (const outcome of ['satisfied', 'invalidated', 'source_unavailable'] as const)
    decodeEventWaitRecord({ ...resolved(), resolution: { ...result, outcome } });
  decodeEventWaitRecord({
    ...resolved(),
    resolvedAt: 10,
    resolution: { ...result, observedAt: 10, evidenceRefs: [] },
  });
  for (const record of [
    { ...resolved(), resolvedAt: 31 },
    { ...resolved(), resolution: { ...result, observedAt: 9 } },
    { ...resolved(), resolution: { ...result, observedAt: 20.5 } },
    { ...cancelled(), cancelledAt: 9 },
    { ...cancelled(), cancelledAt: 31 },
    { ...expired(), expiredAt: 101 },
    { ...cancelled(), cancelledAt: 24, priorResolution: { resolvedAt: 25, resolution: result } },
    { ...cancelled(), priorResolution: { resolvedAt: 9, resolution: result } },
  ])
    assert.throws(() => decodeEventWaitRecord(record), TypeError);
});

test('parameters reject lossy JSON, exotic objects, getters, cycles, sparse arrays and every complexity bound', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const getter = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      throw new Error('getter must not execute');
    },
  });
  const extraArray = Object.assign([1], { extra: 2 });
  for (const parameters of [
    [],
    null,
    { x: undefined },
    { x: NaN },
    { x: Infinity },
    { x: 1n },
    { x: () => {} },
    { x: Symbol() },
    { x: new Date() },
    { x: new Map() },
    { x: Object.create({}) },
    { x: Array(2) },
    { x: extraArray },
    cycle,
    getter,
    { [Symbol()]: 1 },
    Object.defineProperty({}, 'hidden', { value: 1 }),
  ]) {
    assert.throws(
      () =>
        decodeEventWaitRecord({ ...waiting(), condition: { ...waiting().condition, parameters } }),
      TypeError,
    );
  }
  let deep: unknown = 1;
  for (let i = 0; i < 9; i++) deep = { nested: deep };
  for (const parameters of [deep, { many: Array(1024).fill(0) }, { big: '中'.repeat(2800) }])
    assert.throws(() =>
      decodeEventWaitRecord({ ...waiting(), condition: { ...waiting().condition, parameters } }),
    );
  const max = { x: 'a'.repeat(EVENT_WAIT_LIMITS.parameterBytes - 8) };
  assert.equal(JSON.stringify(max).length, EVENT_WAIT_LIMITS.parameterBytes);
  decodeEventWaitRecord({ ...waiting(), condition: { ...waiting().condition, parameters: max } });
  assert.throws(() =>
    decodeEventWaitRecord({
      ...waiting(),
      condition: { ...waiting().condition, parameters: { x: max.x + 'a' } },
    }),
  );
  const pollution = JSON.parse('{"__proto__":{"x":1}}');
  assert.ok(
    Object.hasOwn(
      decodeEventWaitRecord({
        ...waiting(),
        condition: { ...waiting().condition, parameters: pollution },
      }).condition.parameters,
      '__proto__',
    ),
  );
});

test('JSON complexity limits include the parameter root, values, and serialized keys', () => {
  let deepest: unknown = 1;
  for (let i = 0; i < EVENT_WAIT_LIMITS.parameterDepth; i++) deepest = { nested: deepest };
  const maxNodes = { values: Array(EVENT_WAIT_LIMITS.parameterNodes - 2).fill(0) };
  for (const parameters of [deepest, maxNodes, { text: '\u0000\n🚀' }])
    decodeEventWaitRecord({ ...waiting(), condition: { ...waiting().condition, parameters } });
  for (const parameters of [
    { nested: deepest },
    { values: [...maxNodes.values, 0] },
    { ['x'.repeat(EVENT_WAIT_LIMITS.parameterBytes)]: 1 },
    { text: '\u0000'.repeat(EVENT_WAIT_LIMITS.parameterBytes / 6) },
    { '\ud800': 1 },
    { text: '\udfff' },
  ])
    assert.throws(
      () =>
        decodeEventWaitRecord({ ...waiting(), condition: { ...waiting().condition, parameters } }),
      TypeError,
    );
});

test('decoding fixed objects does not execute accessors or accept non-JSON own properties', () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...waiting() }, 'status', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'waiting';
    },
  });
  const symbol = { ...waiting(), [Symbol('extension')]: 1 };
  const hidden = Object.defineProperty({ ...waiting() }, 'extension', { value: 1 });
  const customPrototype = Object.assign(Object.create({}), waiting());
  const nullPrototype = Object.assign(Object.create(null), waiting());
  for (const record of [accessor, symbol, hidden, customPrototype])
    assert.throws(() => decodeEventWaitRecord(record), TypeError);
  assert.equal(getterCalls, 0);
  assert.deepEqual(decodeEventWaitRecord(nullPrototype), waiting());
});

test('decoded JSON isolates shared input objects and compares key order deterministically', () => {
  const shared = { value: 1 };
  const input = {
    ...waiting(),
    condition: { ...waiting().condition, parameters: { z: shared, a: shared } },
  };
  const decoded = decodeEventWaitRecord(input);
  assert.notEqual(decoded.condition.parameters.a, shared);
  assert.notEqual(decoded.condition.parameters.a, decoded.condition.parameters.z);
  shared.value = 2;
  assert.deepEqual(decoded.condition.parameters, { a: { value: 1 }, z: { value: 1 } });
  assertEventWaitTransition(decoded, {
    ...waiting(),
    condition: { ...waiting().condition, parameters: { z: { value: 1 }, a: { value: 1 } } },
  });
});

test('only meaningful transitions and exact no-ops are allowed; resolution is immutable through revocation', () => {
  for (const target of [resolved(), cancelled(), expired()])
    assertEventWaitTransition(waiting(), target);
  for (const terminal of [resolved(), cancelled(), expired()]) {
    assertEventWaitTransition(terminal, terminal);
    assert.throws(() => assertEventWaitTransition(terminal, waiting()));
    assert.throws(() =>
      assertEventWaitTransition(terminal, { ...terminal, updatedAt: terminal.updatedAt + 1 }),
    );
  }
  assert.throws(() => assertEventWaitTransition(waiting(), { ...waiting(), updatedAt: 11 }));
  assert.throws(() =>
    assertEventWaitTransition(resolved(), {
      ...resolved(),
      resolution: { ...result, receiptKey: 'replaced' },
    }),
  );
  const revocation: EventWaitRecord = {
    ...cancelled(),
    priorResolution: { resolvedAt: 25, resolution: result },
  };
  assertEventWaitTransition(resolved(), revocation);
  assert.throws(() => assertEventWaitTransition(waiting(), revocation));
  assert.throws(() => assertEventWaitTransition(resolved(), cancelled()));
  for (const patch of [
    { waitId: 'wait_2', deliveryKey: eventWaitDeliveryKey('wait_2') },
    { sessionId: 'another' },
    { goalControlLease: { goalId: 'goal_1', generation: 1 } },
    { goalControlLease: { goalId: 'goal_2', generation: 0 } },
    { resource: { ...waiting().resource, resourceId: 'changed' } },
    { resource: { ...waiting().resource, connectionId: 'changed' } },
    { resource: { ...waiting().resource, providerId: 'changed' } },
    { resource: { ...waiting().resource, resourceType: 'changed' } },
    { condition: { ...waiting().condition, version: 2 } },
    { condition: { ...waiting().condition, typeId: 'changed' } },
    { condition: { ...waiting().condition, parameters: { n: 2 } } },
    { sourceTurnId: 'turn_2' },
    { sourceToolCallId: 'call:2' },
    { deadlineAt: 101 },
    { createdAt: 9 },
  ])
    assert.throws(() => assertEventWaitTransition(waiting(), { ...resolved(), ...patch }));
});

test('terminal records cannot replace results or reasons or cross terminal states', () => {
  const terminals = [resolved(), cancelled(), expired()];
  for (const previous of terminals) {
    for (const next of terminals) {
      if (previous.status === next.status) continue;
      assert.throws(() => assertEventWaitTransition(previous, next), TypeError);
    }
  }
  assert.throws(
    () => assertEventWaitTransition(cancelled(), { ...cancelled(), reason: 'different' }),
    TypeError,
  );
  assert.throws(
    () => assertEventWaitTransition(expired(), { ...expired(), updatedAt: 101, expiredAt: 101 }),
    TypeError,
  );
  for (const priorResolution of [
    { resolvedAt: 24, resolution: result },
    { resolvedAt: 25, resolution: { ...result, receiptKey: 'different' } },
    { resolvedAt: 25, resolution: { ...result, observedAt: 19 } },
    { resolvedAt: 25, resolution: { ...result, evidenceRefs: [] } },
  ])
    assert.throws(
      () => assertEventWaitTransition(resolved(), { ...cancelled(), priorResolution }),
      TypeError,
    );
  assert.throws(
    () =>
      assertEventWaitTransition(
        { ...waiting(), updatedAt: 20 },
        { ...resolved(), updatedAt: 19, resolvedAt: 19, resolution: { ...result, observedAt: 19 } },
      ),
    TypeError,
  );
});
