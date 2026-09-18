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

# WorkHub realtime voice

This experimental integration connects a realtime voice provider to WorkHub.
No voice provider, private service credentials, patched binaries or provider build
scripts are included. Without a registered provider, call preparation fails before
microphone permission is armed.

## Provider boundary

`apps/desktop/src/main/workhub-voice-provider.ts` defines the desktop composition
contract. A trusted adapter registers a `WorkHubVoiceProvider` and unregisters it
when unloaded. This is an integration seam, not an implemented plugin installer.

The provider supplies its ID, WebRTC data-channel label and a session factory.
Each session implements `connect`, `accept`, `sendSpeech`, `sendReply` and `close`.
The adapter owns authentication, connection negotiation and its native wire format.
Raw control messages cross IPC to `accept`; microphone/audio media remain on WebRTC.
Provider code must report safe user-facing errors without credentials or response bodies.

Adapter callbacks:

- `submit`: delegate work with a stable request ID and originating user turn ID.
  Admission acknowledges receipt, not completion. Repeated IDs must not duplicate work.
- `observe`: emit `{ kind: 'transport', event }` with normalized `turn.created`,
  `turn.delta` and `turn.done` events. A turn has `id`, `role` (`user`/`assistant`),
  `transcript` and optional `start_ms`/`end_ms`; deltas have `turn_id` and `delta`.
  Provider-specific response, speech-buffer and transcript-fragment events must be translated by the adapter; the core does not interpret them. Report every turn completion, including interrupted output. Lifecycle observations
  must be synchronous and ordered; never infer completion from silence.
- `record`: persist bounded collaboration facts, not private provider payloads.
- `onClose` and `onError`: release the active call and report failures.

`sendReply` correlates task replies with the original request; `sendSpeech` supplies
prepared supplemental content. These are separate channels. The provider must
translate both into its native protocol. The renderer displays normalized observations
from the host, so it does not depend on a provider's event format.

## WorkHub and prepared speech

WorkHub keeps its normal task coordination responsibilities. Voice delegations enter a durable
inbox, use the existing start/steer path and return through the original request ID.
Main retains its existing task delegation and child lifecycle behavior; this integration adds no completion callback to WorkHub. The voice layer does not scan child transcripts, poll child completion or inject synthetic task-result messages into WorkHub. It transports replies WorkHub explicitly publishes through `voice_reply`.

Voice transcript fragments are persisted while streaming and consolidated at turn end.
The current `voice-queue.sqlite` database owns the voice history, pending list, delivery receipts and review cursor. Old JSON files are not imported; older or unknown persisted state shapes are rejected without rewriting them. There is no experimental-format migration.

The active call graph has three independent paths:

- Provider `submit` → register the voice request → durable inbox → WorkHub admission/steering. Its receipt confirms acceptance only.
- WorkHub `voice_reply` (or an active WorkHub question/form) → correlated replies → provider `sendReply`. This is an explicit reply transport, not a child-result collector. Plain WorkHub output is not automatically spoken.
- Completed voice turns/log facts → Jev → optional WorkHub maintenance → `voice_queue_update` → checked list item → provider `sendSpeech`.

There is no child completion → synthetic result → WorkHub path. Tests must not assume one. Both voice paths require a separately registered provider.

The ordered list contains prepared speech, not all outstanding tasks. The consumer sends
one approved item at a time while voice is idle. Delivery reservations and exact-snapshot
checks prevent concurrent updates from sending replaced content. Uncertain delivery is
not automatically replayed.

Jev checks recent completed facts and the current list asynchronously after turns and
state changes. New input invalidates previous approval. It identifies missing work and
classifies items as inject, discard or rework. Discards match the exact observed item;
rework remains blocked while WorkHub maintains the list. Old model results cannot approve
newer state. Explicit WorkHub replies bypass this supplemental-list gate.

The checker currently uses TypeSafe's official endpoint. Configure `TYPESAFE_API_KEY`,
`MAKA_TYPESAFE_KEY_FILE`, or `~/.config/maka/typesafe.key` locally. No key belongs in the
repository. Failure leaves supplemental content unapproved and retries later.

## Validation and limitations

Compile desktop main and run its `workhub-voice*.test.js` tests, plus the Runtime Host
voice and inbox suites. `node scripts/voice/jev-scenarios.mjs` explicitly
runs a paid real-model replay using local credentials; it is not a CI test and model
outputs can fail its expectations.

Known limitations: this integration has no automatic child-task completion → WorkHub → voice return path. `voice_reply` only transports information WorkHub already has; it does not retrieve results or wake WorkHub on task completion. WorkHub maintenance can take tens of
seconds; late explicit replies can cause speech after a conversational stop; the semantic
checker can misclassify missing work or delete a still-needed item. A conversational
stop is not a transport disconnect. Provider integration requires separate real-media
validation; generic fake-provider tests do not establish real speech quality.
