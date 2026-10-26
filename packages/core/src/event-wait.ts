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
  cursorBytes: 2048,
  observationAttempts: 1_000_000,
  // Every combination of bounded fields, including observation and a cancelled
  // priorResolution, fits below 42 KiB even with JSON escaping. Leave room for
  // the full lifecycle so an accepted result can always retain its facts on cancel.
  recordBytes: 48 * 1024,
});

/** Checkpoint only, never a second execution or delivery authority. */
export interface EventWaitObservation {
  readonly schemaVersion: 1;
  readonly attempts: number;
  readonly lastAttemptAt: number;
  readonly lastObservedAt: number | null;
  /** Earliest read, including notification-triggered reads. */
  readonly nextObserveAt: number;
  /** Reconciliation fallback even when no notification arrives. */
  readonly nextPollAt: number;
  readonly consecutiveErrors: number;
  readonly outcome: 'checking' | 'pending' | 'unknown' | EventWaitResolution['outcome'];
  readonly cursor: string | null;
  readonly eventKey: string | null;
  /** Bounded diagnostic code, not raw exceptions, logs, or credentials. */
  readonly reason: string | null;
}

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
  readonly observation?: EventWaitObservation;
  readonly delivery?: never;
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

/** Version two separates observation from the consumer's execution authority. */
export type EventWaitConsumer =
  | {
      readonly kind: 'tool_invocation';
      readonly runId: string;
      readonly invocationId: string;
      readonly operationId: string;
      readonly toolCallId: string;
    }
  | {
      readonly kind: 'goal_waiting';
      readonly sourceRunId: string;
      readonly completionEventId: string;
      readonly goalControlLease: GoalControlLease;
      readonly goalRevision: number;
    };
export interface ConsumerEventWaitObservation extends Omit<EventWaitObservation, 'schemaVersion'> {
  readonly schemaVersion: 2;
  /** Monotonic reservation window; rolling it never changes the semantic deadline. */
  readonly window: number;
}
export type ConsumerEventWaitDelivery =
  | {
      readonly kind: 'consumed';
      readonly operationId: string;
      readonly resultEventId: string;
      readonly resultDigest: string;
      readonly at: number;
    }
  | { readonly kind: 'retired'; readonly reason: string; readonly at: number }
  | {
      readonly kind: 'admitted';
      readonly turnId: string;
      readonly runId: string;
      readonly userMessageId: string;
      readonly at: number;
    };
export type ConsumerEventWaitRecord = Omit<
  EventWaitBase,
  'schemaVersion' | 'sourceToolCallId' | 'deadlineAt' | 'observation' | 'delivery'
> & {
  readonly schemaVersion: 2;
  readonly consumer: EventWaitConsumer;
  readonly deadlineAt: number | null;
  readonly observation?: ConsumerEventWaitObservation;
  readonly delivery?: ConsumerEventWaitDelivery;
} & EventWaitLifecycle;
export type AnyEventWaitRecord = EventWaitRecord | ConsumerEventWaitRecord;
export type EventWaitConsumerKind = 'observation' | EventWaitConsumer['kind'];
export function eventWaitConsumerKind(record: AnyEventWaitRecord): EventWaitConsumerKind {
  return record.schemaVersion === 1 ? 'observation' : record.consumer.kind;
}
export function decodeConsumerEventWaitRecord(value: unknown): ConsumerEventWaitRecord {
  return decodeWaitRecord(value, true) as ConsumerEventWaitRecord;
}
export function decodeAnyEventWaitRecord(value: unknown): AnyEventWaitRecord {
  return Object.getOwnPropertyDescriptor(object(value, 'record'), 'schemaVersion')?.value === 2
    ? decodeConsumerEventWaitRecord(value)
    : decodeEventWaitRecord(value);
}
export interface EventWaitConditionSpec {
  readonly resource: EventWaitBase['resource'];
  readonly condition: EventWaitBase['condition'];
  readonly deadlineAt: number | null;
}
export function decodeEventWaitConditionSpec(value: unknown): EventWaitConditionSpec {
  const v = shape(value, ['resource', 'condition', 'deadlineAt']);
  const resource = shape(v.resource, ['providerId', 'connectionId', 'resourceType', 'resourceId']);
  const condition = shape(v.condition, ['typeId', 'version', 'parameters']);
  const parameters = object(
    json(
      condition.parameters,
      EVENT_WAIT_LIMITS.parameterBytes,
      EVENT_WAIT_LIMITS.parameterDepth,
      EVENT_WAIT_LIMITS.parameterNodes,
    ),
    'parameters',
  ) as Record<string, EventWaitJsonValue>;
  return {
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
    deadlineAt: v.deadlineAt === null ? null : integer(v.deadlineAt, 'deadlineAt'),
  };
}
function decodeConsumer(value: unknown): EventWaitConsumer {
  const c = object(value, 'consumer');
  const lease = (v: unknown): GoalControlLease => {
    const l = shape(v, ['goalId', 'generation']);
    return { goalId: id(l.goalId, 'goalId'), generation: integer(l.generation, 'generation') };
  };
  if (c.kind === 'tool_invocation') {
    shape(c, ['kind', 'runId', 'invocationId', 'operationId', 'toolCallId']);
    return {
      kind: c.kind,
      runId: id(c.runId, 'consumer run'),
      invocationId: id(c.invocationId, 'consumer invocation'),
      operationId: id(c.operationId, 'consumer operation'),
      toolCallId: text(c.toolCallId, 'consumer tool call', EVENT_WAIT_LIMITS.toolCallIdBytes),
    };
  }
  if (c.kind === 'goal_waiting') {
    shape(c, ['kind', 'sourceRunId', 'completionEventId', 'goalControlLease', 'goalRevision']);
    return {
      kind: c.kind,
      sourceRunId: id(c.sourceRunId, 'consumer source run'),
      completionEventId: id(c.completionEventId, 'consumer completion'),
      goalControlLease: lease(c.goalControlLease),
      goalRevision: integer(c.goalRevision, 'consumer Goal revision'),
    };
  }
  return invalid('consumer kind');
}

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

/** Ownership is checked by the supplied store and authorizer. */
export function decodeEventWaitRecord(value: unknown): EventWaitRecord {
  return decodeWaitRecord(value) as EventWaitRecord;
}

function decodeWaitRecord(value: unknown, consumer = false): AnyEventWaitRecord {
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
      'sourceTurnId',
      ...(consumer ? ['consumer'] : ['sourceToolCallId']),
      'resource',
      'condition',
      'deliveryKey',
      'createdAt',
      'updatedAt',
      'deadlineAt',
      'status',
      ...lifecycleKeys,
    ],
    root.status === 'cancelled'
      ? ['priorResolution', 'observation', ...(consumer ? ['delivery'] : [])]
      : ['observation', ...(consumer ? ['delivery'] : [])],
  );
  if (r.schemaVersion !== (consumer ? 2 : EVENT_WAIT_SCHEMA_VERSION)) invalid('schemaVersion');
  const spec = decodeEventWaitConditionSpec({
    resource: r.resource,
    condition: r.condition,
    deadlineAt: r.deadlineAt,
  });
  const base = {
    schemaVersion: consumer ? (2 as const) : EVENT_WAIT_SCHEMA_VERSION,
    waitId: id(r.waitId, 'waitId'),
    sessionId: id(r.sessionId, 'sessionId'),
    sourceTurnId: id(r.sourceTurnId, 'sourceTurnId'),
    ...(consumer
      ? { consumer: decodeConsumer(r.consumer) }
      : {
          sourceToolCallId: text(
            r.sourceToolCallId,
            'sourceToolCallId',
            EVENT_WAIT_LIMITS.toolCallIdBytes,
          ),
        }),
    resource: spec.resource,
    condition: spec.condition,
    deliveryKey: eventWaitDeliveryKey(id(r.waitId, 'waitId')),
    createdAt: integer(r.createdAt, 'createdAt'),
    updatedAt: integer(r.updatedAt, 'updatedAt'),
    deadlineAt: consumer && r.deadlineAt === null ? null : integer(r.deadlineAt, 'deadlineAt'),
  };
  if (
    r.deliveryKey !== base.deliveryKey ||
    base.updatedAt < base.createdAt ||
    (!consumer && base.deadlineAt !== null && base.deadlineAt <= base.createdAt)
  )
    invalid('identity or times');
  const time = (v: unknown, upper = base.updatedAt): number => {
    const result = integer(v, 'lifecycle time');
    if (result < base.createdAt || result > upper) invalid('lifecycle time');
    return result;
  };
  if (r.delivery !== undefined) {
    const d = object(r.delivery, 'delivery');
    if (r.status === 'waiting') invalid('delivery before resolution');
    const terminalAt =
      r.status === 'resolved' ? r.resolvedAt : r.status === 'expired' ? r.expiredAt : r.cancelledAt;
    if (time(d.at) < time(terminalAt)) invalid('delivery before terminal fact');
    if (consumer && d.kind === 'consumed') {
      shape(d, ['kind', 'operationId', 'resultEventId', 'resultDigest', 'at']);
      if (
        ('consumer' in base ? base.consumer.kind : undefined) !== 'tool_invocation' ||
        d.operationId !==
          ('consumer' in base && base.consumer.kind === 'tool_invocation'
            ? base.consumer.operationId
            : undefined) ||
        typeof d.resultDigest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(d.resultDigest)
      )
        invalid('consumption');
      Object.assign(base, {
        delivery: {
          kind: 'consumed',
          operationId: id(d.operationId, 'consumed operation'),
          resultEventId: id(d.resultEventId, 'consumed result'),
          resultDigest: d.resultDigest,
          at: time(d.at),
        },
      });
    } else if (consumer && d.kind === 'retired') {
      shape(d, ['kind', 'at', 'reason']);
      Object.assign(base, {
        delivery: {
          kind: 'retired',
          at: time(d.at),
          reason: text(d.reason, 'retirement reason', EVENT_WAIT_LIMITS.reasonBytes),
        },
      });
    } else if (d.kind === 'admitted') {
      if (consumer && ('consumer' in base ? base.consumer.kind : undefined) !== 'goal_waiting')
        invalid('consumer admission');
      shape(d, ['kind', 'turnId', 'runId', 'userMessageId', 'at']);
      if (
        r.status !== 'resolved' &&
        r.status !== 'expired' &&
        !(consumer && r.status === 'cancelled')
      )
        invalid('admission without result');
      Object.assign(base, {
        delivery: {
          kind: 'admitted',
          turnId: id(d.turnId, 'delivery turn'),
          runId: id(d.runId, 'delivery run'),
          userMessageId: id(d.userMessageId, 'delivery message'),
          at: time(d.at),
        },
      });
    } else invalid('delivery kind');
  }
  if (Object.hasOwn(r, 'observation')) {
    const x = shape(r.observation, [
      'schemaVersion',
      'attempts',
      'lastAttemptAt',
      'lastObservedAt',
      'nextObserveAt',
      'nextPollAt',
      'consecutiveErrors',
      'outcome',
      'cursor',
      'eventKey',
      'reason',
      ...(consumer ? ['window'] : []),
    ]);
    const attempts = integer(x.attempts, 'observation attempts', 1);
    const consecutiveErrors = integer(x.consecutiveErrors, 'consecutive errors');
    const lastAttemptAt = time(x.lastAttemptAt);
    const nextObserveAt = integer(x.nextObserveAt, 'next observation');
    const nextPollAt = integer(x.nextPollAt, 'next poll');
    const lastObservedAt = x.lastObservedAt === null ? null : time(x.lastObservedAt);
    if (
      x.schemaVersion !== (consumer ? 2 : 1) ||
      attempts > EVENT_WAIT_LIMITS.observationAttempts ||
      consecutiveErrors > attempts ||
      nextObserveAt < lastAttemptAt ||
      nextPollAt < nextObserveAt ||
      (x.outcome !== 'checking' && (lastObservedAt === null || lastObservedAt < lastAttemptAt)) ||
      typeof x.outcome !== 'string' ||
      ![
        'checking',
        'pending',
        'unknown',
        'satisfied',
        'invalidated',
        'source_unavailable',
      ].includes(x.outcome)
    )
      invalid('observation');
    Object.assign(base, {
      observation: {
        schemaVersion: consumer ? 2 : 1,
        ...(consumer ? { window: integer(x.window, 'observation window') } : {}),
        attempts,
        lastAttemptAt,
        lastObservedAt,
        nextObserveAt,
        nextPollAt,
        consecutiveErrors,
        outcome: x.outcome,
        cursor: x.cursor === null ? null : text(x.cursor, 'cursor', EVENT_WAIT_LIMITS.cursorBytes),
        eventKey:
          x.eventKey === null
            ? null
            : text(x.eventKey, 'event key', EVENT_WAIT_LIMITS.receiptKeyBytes),
        reason:
          x.reason === null
            ? null
            : text(x.reason, 'observation reason', EVENT_WAIT_LIMITS.reasonBytes),
      },
    });
  }
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
      return { ...base, status: 'waiting' } as AnyEventWaitRecord;
    case 'resolved': {
      const resolvedAt = time(r.resolvedAt);
      return {
        ...base,
        status: 'resolved',
        resolvedAt,
        resolution: resolution(r.resolution, resolvedAt),
      } as AnyEventWaitRecord;
    }
    case 'cancelled': {
      const cancelledAt = time(r.cancelledAt);
      const reason = text(r.reason, 'reason', EVENT_WAIT_LIMITS.reasonBytes);
      if (!Object.hasOwn(r, 'priorResolution'))
        return { ...base, status: 'cancelled', cancelledAt, reason } as AnyEventWaitRecord;
      const prior = shape(r.priorResolution, ['resolvedAt', 'resolution']);
      const resolvedAt = time(prior.resolvedAt, cancelledAt);
      return {
        ...base,
        status: 'cancelled',
        cancelledAt,
        reason,
        priorResolution: { resolvedAt, resolution: resolution(prior.resolution, resolvedAt) },
      } as AnyEventWaitRecord;
    }
    case 'expired': {
      const expiredAt = time(r.expiredAt);
      if (base.deadlineAt === null || expiredAt < base.deadlineAt) invalid('premature expiry');
      return { ...base, status: 'expired', expiredAt } as AnyEventWaitRecord;
    }
    default:
      return invalid('status');
  }
}

export function assertEventWaitTransition(previous: EventWaitRecord, next: EventWaitRecord): void {
  assertAnyEventWaitTransition(decodeEventWaitRecord(previous), decodeEventWaitRecord(next));
}
export function assertAnyEventWaitTransition(
  previous: AnyEventWaitRecord,
  next: AnyEventWaitRecord,
): void {
  const a = decodeAnyEventWaitRecord(previous);
  const b = decodeAnyEventWaitRecord(next);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (same(a, b)) return;
  if (a.delivery) invalid('immutable delivery');
  if (b.delivery) {
    const { delivery: _delivery, updatedAt: _updatedAt, ...rest } = b;
    const { updatedAt: _previousTime, ...prior } = a;
    if (same(rest, prior) && b.updatedAt >= a.updatedAt) return;
    const { delivery: _acknowledgement, ...observation } = b;
    assertAnyEventWaitTransition(a, observation);
    return;
  }
  for (const field of [
    'schemaVersion',
    'waitId',
    'sessionId',
    'sourceTurnId',
    'resource',
    'condition',
    'deliveryKey',
    'createdAt',
    'deadlineAt',
  ] as const) {
    if (!same(a[field], b[field])) invalid(`immutable ${field}`);
  }
  if (
    a.schemaVersion !== b.schemaVersion ||
    (a.schemaVersion === 2 && b.schemaVersion === 2
      ? !same(a.consumer, b.consumer)
      : a.schemaVersion === 1 && b.schemaVersion === 1 && a.sourceToolCallId !== b.sourceToolCallId)
  )
    invalid('immutable consumer');
  if (b.updatedAt < a.updatedAt) invalid('time regression');
  if (a.observation) {
    const rolls =
      a.schemaVersion === 2 &&
      b.schemaVersion === 2 &&
      a.observation.attempts === EVENT_WAIT_LIMITS.observationAttempts &&
      b.observation?.attempts === 1 &&
      b.observation.window === a.observation.window + 1;
    if (
      a.schemaVersion === 2 &&
      b.schemaVersion === 2 &&
      b.observation &&
      !rolls &&
      b.observation.window !== a.observation.window
    )
      invalid('observation window');
    if (
      !b.observation ||
      (!rolls && b.observation.attempts < a.observation.attempts) ||
      b.observation.attempts > a.observation.attempts + 1 ||
      b.observation.lastAttemptAt < a.observation.lastAttemptAt ||
      (a.observation.lastObservedAt !== null &&
        (b.observation.lastObservedAt === null ||
          b.observation.lastObservedAt < a.observation.lastObservedAt))
    )
      invalid('observation regression');
    if (
      b.observation.attempts === a.observation.attempts &&
      b.observation.lastAttemptAt !== a.observation.lastAttemptAt
    )
      invalid('attempt time without reservation');
    if (
      (b.observation.attempts > a.observation.attempts || rolls) &&
      (b.status !== 'waiting' ||
        b.observation.outcome !== 'checking' ||
        b.observation.lastObservedAt !== a.observation.lastObservedAt ||
        b.observation.cursor !== a.observation.cursor ||
        b.observation.eventKey !== a.observation.eventKey ||
        // Keep the last unknown visible while the first request in a new
        // window is checking, within the new window's single-attempt bound.
        b.observation.consecutiveErrors !==
          (rolls ? Math.min(1, a.observation.consecutiveErrors) : a.observation.consecutiveErrors))
    )
      invalid('attempt reservation');
  } else if (
    b.observation &&
    (b.observation.attempts !== 1 || (b.schemaVersion === 2 && b.observation.window !== 0))
  )
    invalid('initial observation budget');
  const newReservation =
    b.observation &&
    (b.observation.attempts > (a.observation?.attempts ?? 0) ||
      (a.schemaVersion === 2 &&
        b.schemaVersion === 2 &&
        a.observation &&
        b.observation.window === a.observation.window + 1));
  if (a.status === 'waiting') {
    if (b.status === 'waiting' && b.observation && !same(a.observation, b.observation)) {
      if (newReservation && b.observation.outcome === 'checking') return;
      if (
        a.observation?.outcome === 'checking' &&
        (b.observation.outcome === 'pending' || b.observation.outcome === 'unknown')
      )
        return;
      invalid('observation update without reservation');
    }
    if (b.status === 'resolved' && b.deadlineAt !== null && b.resolvedAt >= b.deadlineAt)
      invalid('resolution after deadline');
    if (
      b.status === 'resolved' ||
      b.status === 'expired' ||
      (b.status === 'cancelled' && !b.priorResolution)
    )
      return;
  } else if (
    a.status === 'resolved' &&
    b.status === 'cancelled' &&
    same(a.observation, b.observation) &&
    same(b.priorResolution, { resolvedAt: a.resolvedAt, resolution: a.resolution })
  )
    return;
  invalid('state transition');
}
