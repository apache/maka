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

import type { GoalControlLease } from './goal.js';

export const EVENT_WAIT_SCHEMA_VERSION = 1 as const;

export const EVENT_WAIT_LIMITS = Object.freeze({
  idBytes: 128,
  typeIdBytes: 128,
  resourceIdBytes: 2048,
  toolCallIdBytes: 512,
  parameterBytes: 8192,
  parameterDepth: 8,
  parameterNodes: 1024,
  receiptKeyBytes: 512,
  evidenceRefs: 8,
  evidenceRefBytes: 1024,
  reasonBytes: 1024,
  recordBytes: 32768,
});

export type EventWaitJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EventWaitJsonValue[]
  | { readonly [key: string]: EventWaitJsonValue };

export interface EventWaitBase {
  readonly schemaVersion: 1;
  readonly waitId: string;
  readonly sessionId: string;
  readonly goalControlLease: GoalControlLease;
  readonly sourceTurnId: string;
  readonly sourceToolCallId: string;
  readonly resource: {
    readonly providerId: string;
    readonly connectionId: string | null;
    readonly resourceType: string;
    readonly resourceId: string;
  };
  readonly condition: {
    readonly typeId: string;
    readonly version: number;
    readonly parameters: Readonly<Record<string, EventWaitJsonValue>>;
  };
  readonly deliveryKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deadlineAt: number;
}

export interface EventWaitResolution {
  readonly outcome: 'satisfied' | 'invalidated' | 'source_unavailable';
  readonly receiptKey: string;
  readonly observedAt: number;
  readonly evidenceRefs: readonly string[];
}

export type EventWaitLifecycle =
  | { readonly status: 'waiting' }
  | {
      readonly status: 'resolved';
      readonly resolvedAt: number;
      readonly resolution: EventWaitResolution;
    }
  | {
      readonly status: 'cancelled';
      readonly cancelledAt: number;
      readonly reason: string;
      readonly priorResolution?: {
        readonly resolvedAt: number;
        readonly resolution: EventWaitResolution;
      };
    }
  | { readonly status: 'expired'; readonly expiredAt: number };

export type EventWaitRecord = EventWaitBase & EventWaitLifecycle;
export type EventWaitStatus = EventWaitRecord['status'];

const encoder = new TextEncoder();
const invalidIdCharacterPattern = /[^A-Za-z0-9_-]/u;
const invalidTypeCharacterPattern = /[^A-Za-z0-9_.-]/u;
const loneSurrogatePattern = /[\ud800-\udfff]/u;
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/u;

function invalid(field: string): never {
  throw new TypeError(`Invalid event wait ${field}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    invalid(field);
  return value as Record<string, unknown>;
}

function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = object(value, 'object');
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Reflect.ownKeys(result).some(
      (key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)),
    )
  )
    invalid('fields');
  return result;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(field);
  return value;
}

function text(value: unknown, field: string, bytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > bytes ||
    encoder.encode(value).length > bytes ||
    controlPattern.test(value) ||
    loneSurrogatePattern.test(value)
  )
    invalid(field);
  return value;
}

function id(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > EVENT_WAIT_LIMITS.idBytes ||
    invalidIdCharacterPattern.test(value)
  )
    invalid(field);
  return value;
}

function typeId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > EVENT_WAIT_LIMITS.typeIdBytes ||
    invalidTypeCharacterPattern.test(value)
  )
    invalid('type identifier');
  return value;
}

/** Validate before serialization: JSON.stringify must not silently discard data. */
function json(
  value: unknown,
  maxBytes: number,
  maxDepth: number,
  maxNodes: number,
): EventWaitJsonValue {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const addBytes = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) invalid('JSON bytes');
  };
  const visit = (input: unknown, depth: number): EventWaitJsonValue => {
    if (++nodes > maxNodes || depth > maxDepth) invalid('JSON complexity');
    if (input === null || typeof input === 'boolean') {
      addBytes(JSON.stringify(input).length);
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) invalid('JSON number');
      addBytes(JSON.stringify(input).length);
      return input === 0 ? 0 : input;
    }
    if (typeof input === 'string') {
      if (input.length > maxBytes || loneSurrogatePattern.test(input)) invalid('JSON string');
      addBytes(encoder.encode(JSON.stringify(input)).length);
      return input;
    }
    if (typeof input !== 'object' || input === null || ancestors.has(input)) invalid('JSON value');
    ancestors.add(input);
    let output: EventWaitJsonValue;
    const keys = Reflect.ownKeys(input);
    if (keys.length > maxNodes + 1) invalid('JSON complexity');
    if (Array.isArray(input)) {
      if (
        Object.getPrototypeOf(input) !== Array.prototype ||
        keys.length !== input.length + 1 ||
        input.length > maxNodes
      )
        invalid('JSON array');
      const items: EventWaitJsonValue[] = [];
      for (let i = 0; i < input.length; i++) {
        const entry = Object.getOwnPropertyDescriptor(input, String(i));
        if (!entry || !('value' in entry) || !entry.enumerable) invalid('JSON array entry');
        items.push(visit(entry.value, depth + 1));
      }
      addBytes(2 + Math.max(0, items.length - 1));
      output = items;
    } else {
      object(input, 'JSON object');
      const entries: [string, EventWaitJsonValue][] = [];
      for (const key of keys) {
        if (typeof key !== 'string' || key.length > maxBytes || loneSurrogatePattern.test(key))
          invalid('JSON key');
        const entry = Object.getOwnPropertyDescriptor(input, key)!;
        if (!('value' in entry) || !entry.enumerable) invalid('JSON property');
        addBytes(encoder.encode(JSON.stringify(key)).length + 1);
        entries.push([key, visit(entry.value, depth + 1)]);
      }
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      addBytes(2 + Math.max(0, entries.length - 1));
      output = Object.fromEntries(entries);
    }
    ancestors.delete(input);
    return output;
  };
  return visit(value, 0);
}

export function eventWaitDeliveryKey(waitId: string): string {
  return `event-wait/${id(waitId, 'waitId')}`;
}

/** Correlation only: decoding does not authenticate Goal ownership or external truth. */
export function decodeEventWaitRecord(value: unknown): EventWaitRecord {
  const root = object(json(value, EVENT_WAIT_LIMITS.recordBytes, 16, 2048), 'record');
  const lifecycleKeys =
    root.status === 'waiting'
      ? []
      : root.status === 'resolved'
        ? ['resolvedAt', 'resolution']
        : root.status === 'cancelled'
          ? ['cancelledAt', 'reason']
          : root.status === 'expired'
            ? ['expiredAt']
            : invalid('status');
  const r = shape(
    root,
    [
      'schemaVersion',
      'waitId',
      'sessionId',
      'goalControlLease',
      'sourceTurnId',
      'sourceToolCallId',
      'resource',
      'condition',
      'deliveryKey',
      'createdAt',
      'updatedAt',
      'deadlineAt',
      'status',
      ...lifecycleKeys,
    ],
    root.status === 'cancelled' ? ['priorResolution'] : [],
  );
  if (r.schemaVersion !== EVENT_WAIT_SCHEMA_VERSION) invalid('schemaVersion');
  const lease = shape(r.goalControlLease, ['goalId', 'generation']);
  const resource = shape(r.resource, ['providerId', 'connectionId', 'resourceType', 'resourceId']);
  const condition = shape(r.condition, ['typeId', 'version', 'parameters']);
  const parameters = object(
    json(
      condition.parameters,
      EVENT_WAIT_LIMITS.parameterBytes,
      EVENT_WAIT_LIMITS.parameterDepth,
      EVENT_WAIT_LIMITS.parameterNodes,
    ),
    'parameters',
  ) as Record<string, EventWaitJsonValue>;
  const base: EventWaitBase = {
    schemaVersion: EVENT_WAIT_SCHEMA_VERSION,
    waitId: id(r.waitId, 'waitId'),
    sessionId: id(r.sessionId, 'sessionId'),
    goalControlLease: {
      goalId: id(lease.goalId, 'goalId'),
      generation: integer(lease.generation, 'generation'),
    },
    sourceTurnId: id(r.sourceTurnId, 'sourceTurnId'),
    sourceToolCallId: text(
      r.sourceToolCallId,
      'sourceToolCallId',
      EVENT_WAIT_LIMITS.toolCallIdBytes,
    ),
    resource: {
      providerId: typeId(resource.providerId),
      connectionId:
        resource.connectionId === null ? null : id(resource.connectionId, 'connectionId'),
      resourceType: typeId(resource.resourceType),
      resourceId: text(resource.resourceId, 'resourceId', EVENT_WAIT_LIMITS.resourceIdBytes),
    },
    condition: {
      typeId: typeId(condition.typeId),
      version: integer(condition.version, 'condition version', 1),
      parameters,
    },
    deliveryKey: eventWaitDeliveryKey(id(r.waitId, 'waitId')),
    createdAt: integer(r.createdAt, 'createdAt'),
    updatedAt: integer(r.updatedAt, 'updatedAt'),
    deadlineAt: integer(r.deadlineAt, 'deadlineAt'),
  };
  if (
    r.deliveryKey !== base.deliveryKey ||
    base.updatedAt < base.createdAt ||
    base.deadlineAt <= base.createdAt
  )
    invalid('identity or times');
  const time = (v: unknown, upper = base.updatedAt): number => {
    const result = integer(v, 'lifecycle time');
    if (result < base.createdAt || result > upper) invalid('lifecycle time');
    return result;
  };
  const resolution = (v: unknown, resolvedAt: number): EventWaitResolution => {
    const x = shape(v, ['outcome', 'receiptKey', 'observedAt', 'evidenceRefs']);
    if (
      x.outcome !== 'satisfied' &&
      x.outcome !== 'invalidated' &&
      x.outcome !== 'source_unavailable'
    )
      invalid('outcome');
    if (!Array.isArray(x.evidenceRefs) || x.evidenceRefs.length > EVENT_WAIT_LIMITS.evidenceRefs)
      invalid('evidenceRefs');
    return {
      outcome: x.outcome,
      receiptKey: text(x.receiptKey, 'receiptKey', EVENT_WAIT_LIMITS.receiptKeyBytes),
      observedAt: time(x.observedAt, resolvedAt),
      evidenceRefs: x.evidenceRefs.map((v) =>
        text(v, 'evidenceRef', EVENT_WAIT_LIMITS.evidenceRefBytes),
      ),
    };
  };
  switch (r.status) {
    case 'waiting':
      return { ...base, status: 'waiting' };
    case 'resolved': {
      const resolvedAt = time(r.resolvedAt);
      return {
        ...base,
        status: 'resolved',
        resolvedAt,
        resolution: resolution(r.resolution, resolvedAt),
      };
    }
    case 'cancelled': {
      const cancelledAt = time(r.cancelledAt);
      const reason = text(r.reason, 'reason', EVENT_WAIT_LIMITS.reasonBytes);
      if (!Object.hasOwn(r, 'priorResolution'))
        return { ...base, status: 'cancelled', cancelledAt, reason };
      const prior = shape(r.priorResolution, ['resolvedAt', 'resolution']);
      const resolvedAt = time(prior.resolvedAt, cancelledAt);
      return {
        ...base,
        status: 'cancelled',
        cancelledAt,
        reason,
        priorResolution: { resolvedAt, resolution: resolution(prior.resolution, resolvedAt) },
      };
    }
    case 'expired': {
      const expiredAt = time(r.expiredAt);
      if (expiredAt < base.deadlineAt) invalid('premature expiry');
      return { ...base, status: 'expired', expiredAt };
    }
    default:
      return invalid('status');
  }
}

export function assertEventWaitTransition(previous: EventWaitRecord, next: EventWaitRecord): void {
  const a = decodeEventWaitRecord(previous);
  const b = decodeEventWaitRecord(next);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (same(a, b)) return;
  for (const field of [
    'schemaVersion',
    'waitId',
    'sessionId',
    'goalControlLease',
    'sourceTurnId',
    'sourceToolCallId',
    'resource',
    'condition',
    'deliveryKey',
    'createdAt',
    'deadlineAt',
  ] as const) {
    if (!same(a[field], b[field])) invalid(`immutable ${field}`);
  }
  if (b.updatedAt < a.updatedAt) invalid('time regression');
  if (a.status === 'waiting') {
    if (
      b.status === 'resolved' ||
      b.status === 'expired' ||
      (b.status === 'cancelled' && !b.priorResolution)
    )
      return;
  } else if (
    a.status === 'resolved' &&
    b.status === 'cancelled' &&
    same(b.priorResolution, { resolvedAt: a.resolvedAt, resolution: a.resolution })
  )
    return;
  invalid('state transition');
}
