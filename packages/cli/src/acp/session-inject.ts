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

/**
 * Mid-turn user-message injection, per the `session/inject` proposal
 * (`session/inject` with `queue` | `steer`, plus the mandatory
 * `session/revoke_inject`).
 *
 * The runtime underneath already distinguishes the two placements — a message
 * submitted as `current_turn` is delivered at the next break point of the run
 * in progress, `next_turn` waits for it to end — so this module is the ACP
 * shape of that capability, not a second implementation of it.
 *
 * Scope: inject, revoke, and the delivered message appearing in `session/load`
 * replay. **Live delivery is not echoed.** The Runtime Host does not surface a
 * user message on the live event stream (only agent text, thinking and tool
 * activity), so there is nothing to forward at the moment of delivery. This
 * adapter is also one client per session: the caller already knows what it
 * injected, and nothing else is attached to observe it. When multi-client
 * attach exists, the echo becomes meaningful and needs a delivery signal from
 * the Host rather than a guess.
 *
 * Known deviations from the proposal this implements, all deliberate and
 * unaddressed here rather than silently different:
 *
 *  - **Error shape.** An unknown id and an already-delivered id both answer
 *    -32002 without a `reason`; the draft splits them into `-32002
 *    unknown_message_id` and `-32010 already_delivered`, and asks a repeated
 *    revoke of an already-revoked id to succeed. The Host exposes no
 *    "delivered" state (queue entries are `queued`/`in_flight`/`retracted`,
 *    execution resolutions `inbox`/`pending`/`cancelled`/`not_admitted`/`owned`),
 *    so splitting them means tracking injected ids in this adapter.
 *  - **`session/cancel` discards pending injects.** The stop fence drops queued
 *    steering and follow-up entries; the draft asks them to survive a cancel.
 *  - **Attachments are not published before admission.** `inject` maps content
 *    only, so a `resource_link` reaches the Host as a lazily read file
 *    reference, unlike `session/prompt`, which uploads before admitting.
 *  - **A queued inject needs an observer for live output.** `queue` mode is
 *    accepted on a Session created moments ago, before any prompt, load or
 *    resume, and the Host does run it — but live delivery needs an attachment,
 *    and this adapter opens one from those requests. A cold-Session queue
 *    therefore completes invisibly and is readable afterwards through
 *    `session/load`. Refusing it instead would drop work the Host can do.
 */

export const SESSION_INJECT_METHOD = 'session/inject';
export const SESSION_REVOKE_INJECT_METHOD = 'session/revoke_inject';

/** "Inject precondition failed": `data.reason` discriminates the cases. */
export const INJECT_PRECONDITION_FAILED = -32010;
/** Reused for an unknown message id, per the proposal. */
export const INJECT_NOT_FOUND = -32002;

export type SessionInjectMode = 'queue' | 'steer';

export interface InjectSessionRequest {
  readonly sessionId: string;
  readonly mode: SessionInjectMode;
  readonly content: readonly unknown[];
}

export interface RevokeInjectRequest {
  readonly sessionId: string;
  readonly messageId: string;
}

/** Advertised in `initialize` under `sessionCapabilities.inject`. */
export const INJECT_CAPABILITY = {
  modes: ['queue', 'steer'],
  // This build finishes the in-flight stream before delivering a steer.
  steerInStream: ['finish'],
} as const;

export class AcpInjectInputError extends Error {
  readonly name = 'AcpInjectInputError';
  constructor(
    readonly field: 'sessionId' | 'mode' | 'content' | 'messageId',
    readonly reason: 'missing' | 'invalid' | 'unsupported',
  ) {
    super(`Invalid ACP Session inject ${field}`);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function name(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function decodeInjectRequest(value: unknown): InjectSessionRequest {
  const input = record(value);
  if (!input) throw new AcpInjectInputError('sessionId', 'missing');
  const sessionId = name(input.sessionId);
  if (!sessionId) throw new AcpInjectInputError('sessionId', 'missing');

  const mode = name(input.mode);
  if (!mode) throw new AcpInjectInputError('mode', 'missing');
  // Unknown values that do not begin with `_` are reserved for future ACP
  // variants, and `_` ones for implementations; neither is ours to silently
  // accept, so an unsupported mode fails instead of defaulting to queue.
  if (mode !== 'queue' && mode !== 'steer') {
    throw new AcpInjectInputError('mode', 'unsupported');
  }

  const content = Array.isArray(input.content) ? input.content : null;
  if (!content || content.length === 0) throw new AcpInjectInputError('content', 'missing');

  return { sessionId, mode, content };
}

export function decodeRevokeRequest(value: unknown): RevokeInjectRequest {
  const input = record(value);
  if (!input) throw new AcpInjectInputError('sessionId', 'missing');
  const sessionId = name(input.sessionId);
  if (!sessionId) throw new AcpInjectInputError('sessionId', 'missing');
  const messageId = name(input.messageId);
  if (!messageId) throw new AcpInjectInputError('messageId', 'missing');
  return { sessionId, messageId };
}

/** ACP delivery mode → the runtime's message placement. */
export function placementFor(mode: SessionInjectMode): 'current_turn' | 'next_turn' {
  return mode === 'steer' ? 'current_turn' : 'next_turn';
}
