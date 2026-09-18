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

import { requireEntityId, requireExactRecord, requireRecord, requireUtf8String } from './codec.js';

export interface WorkHubVoiceObservation {
  id: string;
  callId: string;
  entries: VoiceLogInput[];
  review?: boolean;
  /** Exact item snapshots: concurrent WorkHub edits must not be deleted. */
  discard?: VoiceQueueItem[];
}
export interface VoiceReview {
  id: string;
  callId: string;
  after: number;
  through: number;
  status: 'admitted' | 'completed' | 'failed';
}
export interface VoiceLogInput {
  id: string;
  kind: string;
  data: Record<string, unknown>;
}
export interface VoiceInterruption {
  userTurnId: string;
  user: string;
  assistant: { id: string; text: string; start_ms?: number; end_ms?: number };
}
export interface VoiceRequest {
  id: string;
  callId: string;
  userTurnId: string;
}
export interface VoiceQueueItem {
  id: string;
  text: string;
  context: string;
  reply?: VoiceRequest & { kind: 'answer' | 'update' | 'question' | 'failure' };
}
export interface VoiceDelivery extends VoiceQueueItem {
  callId: string;
  deliveryId: string;
  status: 'reserved' | 'sent' | 'uncertain' | 'resolved';
}
export interface VoiceDeliveryInput extends Omit<VoiceDelivery, 'status'> {
  status: VoiceDelivery['status'] | 'release';
  expectedQueue?: VoiceQueueItem[];
}
export interface WorkHubVoiceState {
  queue: VoiceQueueItem[];
  /** Explicit WorkHub replies, independent of the supplemental speech list. */
  responses?: VoiceQueueItem[];
  deliveries: VoiceDelivery[];
  receivedObservationId?: string;
  review?: VoiceReview;
}
export interface VoiceEnqueueInput {
  id: string;
  text: string;
  kind: 'answer' | 'update' | 'question' | 'failure';
  requestId: string;
}

export function decodeVoiceRequest(value: unknown): VoiceRequest {
  const v = requireExactRecord(value, 'Voice request', ['id', 'callId', 'userTurnId']);
  return {
    id: requireEntityId(v.id, 'Voice request id'),
    callId: requireEntityId(v.callId, 'Voice request call'),
    userTurnId: requireEntityId(v.userTurnId, 'Voice user turn'),
  };
}

export function decodeVoiceObservation(value: unknown): WorkHubVoiceObservation {
  const record = requireRecord(value, 'Voice log write');
  const v = requireExactRecord(record, 'Voice log write', [
    'id',
    'callId',
    'entries',
    ...('review' in record ? ['review'] : []),
    ...('discard' in record ? ['discard'] : []),
  ]);
  if (!Array.isArray(v.entries) || v.entries.length > 128)
    throw new Error('Invalid voice log entries');
  if (v.review !== undefined && typeof v.review !== 'boolean')
    throw new Error('Invalid review flag');
  if (v.discard !== undefined && (!Array.isArray(v.discard) || v.discard.length > 256))
    throw new Error('Invalid discard items');
  return {
    ...(v.discard === undefined
      ? {}
      : { discard: (v.discard as unknown[]).map(decodeVoiceQueueItem) }),
    id: requireEntityId(v.id, 'Voice write id'),
    callId: requireEntityId(v.callId, 'Voice call id'),
    entries: v.entries.map((value) => {
      const e = requireExactRecord(value, 'Voice log entry', ['id', 'kind', 'data']);
      const data = requireRecord(e.data, 'Voice event data');
      if (Buffer.byteLength(JSON.stringify(data)) > 128_000)
        throw new Error('Voice event too large');
      return {
        id: requireEntityId(e.id, 'Voice log id'),
        kind: requireUtf8String(e.kind, 'Voice event kind', 128),
        data,
      };
    }),
    ...(v.review === undefined ? {} : { review: v.review }),
  };
}
export function decodeVoiceQueueItem(value: unknown): VoiceQueueItem {
  const record = requireRecord(value, 'Voice queue item');
  const v = requireExactRecord(record, 'Voice queue item', [
    'id',
    'text',
    'context',
    ...['reply'].filter((key) => Object.hasOwn(record, key)),
  ]);
  let reply: VoiceQueueItem['reply'];
  if (v.reply !== undefined) {
    const r = requireExactRecord(v.reply, 'Voice reply', ['id', 'callId', 'userTurnId', 'kind']);
    if (!['answer', 'update', 'question', 'failure'].includes(String(r.kind)))
      throw new Error('Invalid voice reply kind');
    reply = {
      ...decodeVoiceRequest({ id: r.id, callId: r.callId, userTurnId: r.userTurnId }),
      kind: r.kind as NonNullable<VoiceQueueItem['reply']>['kind'],
    };
  }
  const id = requireEntityId(v.id, 'Voice queue id');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid voice queue id');
  return {
    id,
    text: requireUtf8String(v.text, 'Voice queue text', 32_000),
    context: v.context === '' ? '' : requireUtf8String(v.context, 'Voice queue context', 32_000),
    ...(reply ? { reply } : {}),
  };
}
export function decodeVoiceEnqueue(value: unknown): VoiceEnqueueInput {
  const record = requireRecord(value, 'Voice output');
  const v = requireExactRecord(record, 'Voice output', ['id', 'text', 'kind', 'requestId']);
  if (!['answer', 'update', 'question', 'failure'].includes(String(v.kind)))
    throw new Error('Invalid voice output kind');
  const { id, text } = decodeVoiceQueueItem({ id: v.id, text: v.text, context: '' });
  return {
    id,
    text,
    kind: v.kind as VoiceEnqueueInput['kind'],
    requestId: requireEntityId(v.requestId, 'Voice reply request'),
  };
}
export function decodeVoiceDelivery(value: unknown): VoiceDeliveryInput {
  const record = requireRecord(value, 'Voice delivery');
  const v = requireExactRecord(record, 'Voice delivery', [
    'id',
    'text',
    'context',
    'callId',
    'deliveryId',
    'status',
    ...['reply', 'expectedQueue'].filter((key) => Object.hasOwn(record, key)),
  ]);
  if (!['reserved', 'sent', 'uncertain', 'resolved', 'release'].includes(String(v.status)))
    throw new Error('Invalid delivery status');
  if (
    v.expectedQueue !== undefined &&
    (!Array.isArray(v.expectedQueue) || v.expectedQueue.length > 256)
  )
    throw new Error('Invalid expected queue');
  return {
    ...(v.expectedQueue === undefined
      ? {}
      : { expectedQueue: (v.expectedQueue as unknown[]).map(decodeVoiceQueueItem) }),
    ...decodeVoiceQueueItem({
      id: v.id,
      text: v.text,
      context: v.context,
      ...(v.reply ? { reply: v.reply } : {}),
    }),
    callId: requireEntityId(v.callId, 'Voice call id'),
    deliveryId: requireEntityId(v.deliveryId, 'Voice delivery id'),
    status: v.status as VoiceDeliveryInput['status'],
  };
}
export function decodeVoiceState(value: unknown): WorkHubVoiceState {
  const record = requireRecord(value, 'Voice state');
  const v = requireExactRecord(record, 'Voice state', [
    'queue',
    'deliveries',
    ...['receivedObservationId', 'review', 'responses'].filter((key) => Object.hasOwn(record, key)),
  ]);
  if (!Array.isArray(v.queue) || v.queue.length > 256 || !Array.isArray(v.deliveries))
    throw new Error('Invalid voice queue state');
  const queue = v.queue.map(decodeVoiceQueueItem);
  if (v.responses !== undefined && (!Array.isArray(v.responses) || v.responses.length > 256))
    throw new Error('Invalid voice responses');
  const responses = (v.responses as unknown[] | undefined)?.map(decodeVoiceQueueItem);
  if (responses?.some((item) => !item.reply)) throw new Error('Voice response requires a request');
  const deliveries = v.deliveries.map((value) => {
    const delivery = decodeVoiceDelivery(value);
    if (delivery.status === 'release') throw new Error('Invalid recorded delivery');
    return delivery as VoiceDelivery;
  });
  const ids = [...queue, ...(responses ?? []), ...deliveries].map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate voice queue id');
  let review: VoiceReview | undefined;
  if (v.review !== undefined) {
    const r = requireExactRecord(v.review, 'Voice review', [
      'id',
      'callId',
      'after',
      'through',
      'status',
    ]);
    if (
      !Number.isSafeInteger(r.after) ||
      !Number.isSafeInteger(r.through) ||
      Number(r.after) < 0 ||
      Number(r.through) < Number(r.after) ||
      !['admitted', 'completed', 'failed'].includes(String(r.status))
    )
      throw new Error('Invalid voice review');
    review = {
      id: requireEntityId(r.id, 'Review id'),
      callId: requireEntityId(r.callId, 'Review call'),
      after: Number(r.after),
      through: Number(r.through),
      status: r.status as VoiceReview['status'],
    };
  }
  return {
    queue,
    ...(responses?.length ? { responses } : {}),
    deliveries,
    ...(review ? { review } : {}),
    ...(v.receivedObservationId === undefined
      ? {}
      : {
          receivedObservationId: requireEntityId(v.receivedObservationId, 'Received observation'),
        }),
  };
}
