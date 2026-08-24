<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# OpenAI Responses incremental transport

## 1. Problem and invariant

Long tool loops currently rebuild and upload the complete provider history on every step. The
durable Runtime event ledger remains the source of truth, but the OpenAI Responses transport may
reuse a turn-scoped WebSocket and send only the suffix after the previous response.

The optimization must never change the logical request. A continuation is eligible only when the
current Maka message list is exactly:

1. the previous request messages;
2. followed by Maka's durable replay projection of the previous provider step;
3. followed by at least one new message.

Otherwise the adapter sends the complete request and starts a new continuation chain.

The provider response id is observed at the adapter boundary, but the semantic response messages
are not copied from `sdk.response.messages`. After client tools settle durably, the Runtime reloads
that step from the event ledger and completes the continuation baseline with the same projection
the next request will use. A projection mismatch fails closed to a full request.

## 2. Ownership and lifecycle

- `ModelAdapter` owns semantic continuation state, keyed by turn id so concurrent turns never
  share a chain.
- The OpenAI Responses transport owns the matching WebSocket and wire request/response state.
- The session id supplies a stable `prompt_cache_key`; an explicit caller value wins.
- Durable history remains complete. Only the provider-bound wire projection is incremental.
- Each active lane retains at most one full wire request/output baseline and one semantic
  request/response baseline until the turn ends. These snapshots are intentionally not byte-capped:
  image-heavy requests can retain several megabytes for the turn so an HTTP retry can reconstruct
  complete history. `endLane`/`close` synchronously releases them; adding a byte cap would trade that
  recovery guarantee for lower peak memory and requires a separate policy decision.

## 3. Failure matrix

| Condition | Behavior |
| --- | --- |
| First request or message-prefix mismatch | Full request over WebSocket |
| Request options/model/tools changed | Full request; replace the chain baseline |
| Missing/stale response id | Clear the chain; Runtime retry starts from durable full history |
| WebSocket connect failure | Full HTTP request; suppress new socket attempts for five minutes across turns |
| Cooldown expires on a lane that temporarily used HTTP | Retry WebSocket with full history, then resume delta continuation on that socket |
| Socket closes or stream fails | Clear the chain, start the retry cooldown, and let Runtime retry from full history |
| `response.incomplete` for a reason other than output-token truncation | Surface a provider failure instead of a silent successful turn |
| Same turn attempts concurrent requests | Full HTTP request for the contender |
| Abort/cancel | Close the socket and clear the chain |
| Model fetch carries an immutable network-proxy snapshot | WebSocket uses the same proxy and bypass list; direct legacy fetch wiring has no proxy snapshot to inherit |
| OAuth subscription or Chat Completions model | Existing transport, unchanged |

## 4. Test plan

- Unit-test exact semantic prefix/delta selection and every mismatch fallback.
- Unit-test stable cache-key merging without overwriting explicit provider options.
- Exercise a local WebSocket server to verify connection reuse, `previous_response_id`, delta-only
  input, and SSE translation.
- Exercise the complete adapter/backend loop so a reasoning step is persisted, replayed, and used
  as the next delta baseline rather than comparing against the SDK response representation.
- Verify WebSocket setup failure reconstructs and sends a complete HTTP request.
- Verify mid-stream close, binary frames, and stale continuation state are retryable; abort remains
  non-retryable and does not start the cross-turn cooldown.
- Verify busy-lane HTTP fallback, non-truncation incomplete responses, and idle-socket protocol
  errors without fixed-duration sleeps.
- Verify the failure cooldown survives turn cleanup, expires deterministically, and does not evict
  an already healthy concurrent lane; a lane used during cooldown recovers after expiry.
- Run Runtime typecheck and focused tests, then the repository validation appropriate to the diff.

## 5. Observability and rollout

The existing provider-attempt telemetry already records request bytes, latency, time to first token,
and cache usage. Rollout can compare those fields by provider step. WebSocket is limited to the
API-key OpenAI Responses adapter; direct, HTTP(S)-proxy, and SOCKS5 routes follow the existing
transport snapshot. Every failure path preserves a complete HTTP fallback. OAuth subscription
transports remain on their refresh-aware HTTP path.

## 6. Verification outcome

- Runtime TypeScript build passes.
- Focused continuation, adapter/backend contract, WebSocket failure, and provider-classification
  tests: 34 passed.
- HTTP proxy behavior is exercised end-to-end through an authenticated local CONNECT proxy.
- SOCKS5 selection and shared bypass-list routing are covered at the transport boundary.
- Runtime-wide verification: 3,217 tests, 3,208 passed, 9 skipped, 0 failed.
