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

# ACP live Session behavior

The adapter retains a Runtime Host subscription after the first prompt. Cancellation
and close use the subscription's current root identity, including a Turn started by
another Host client while the ACP attachment was idle. Close releases the subscription
and connection-local ownership; it does not delete or archive the durable Session.

ACP v1 message chunks are append-only. Matching replay and prefix extensions are
supported. If a completed or recovered message changes text or thinking that was
already streamed (including clearing it), the adapter rejects the prompt with
JSON-RPC error `-32603` and `error.data.code: unsupported_stream_revision` and requests
a stop of that prompt's exact live root. It never represents a replacement by inventing
a new message ID or reports `end_turn` for that failed projection. The client may
still display the already delivered partial text; ACP v1 cannot retract it. The
Session remains owned and can accept another prompt or be closed.

Local resource links must identify regular files. Filesystem admission rejects
non-regular files, including POSIX FIFOs, before reading their content.
After live attachment succeeds, the adapter uploads each linked file through the
Host's existing Session Artifact protocol and uses its canonical attachment
reference for Turn admission. Cancellation or close during an upload aborts staged
content and prevents that prompt from starting a Turn.

When a dispatched start loses its response, the adapter retries admission queries
with bounded deadlines instead of replaying the start. Only a matching Turn or
authoritative `not_found` settles admission. Exhausted reads report `outcome_unknown`;
explicit cancellation still returns `cancelled`, with the failed Stop diagnostic
retained. Shutdown can cancel an initial attachment waiting for transcript hydration
or reconnection without waiting for the Host to become available.

Pending permission, question, form, sandbox-boundary and client-capability
interactions for an active ACP prompt use the client's negotiated standard
`session/request_permission` or `elicitation/create` methods. The Host still owns
canonical answers and grants. The adapter preserves typed form values, permission
scope, external answers and closure reasons; an unsupported client method fails
the affected prompt rather than leaving it pending. Cancelling a question cancels
the active Turn because Host question answers have no cancellation variant;
cancelling a form is forwarded as the Host form `cancel` result. Interactions
belonging to another client's Turn are not presented through this ACP connection.

Cancelling a Turn releases local dialog waits immediately. Its cancellation fence
remains in place even after the ACP prompt returns if Stop delivery failed and
the Host Turn is still running. Only an authoritative terminal Turn observation
or attachment closure releases that fence, preventing a fresh interaction from
opening a dialog or submitting an answer after cancellation.

## Tool output and completion

ACP projects Runtime Host tool activity as `tool_call` followed by cumulative
`tool_call_update` snapshots. Output, progress and previews update one card,
including when start arrives late. Input previews are labelled as previews. A
complete authoritative result replaces the live output. `contentOmitted` preserves
the existing display and requires transcript reconciliation. Raw input/output is
omitted when completeness cannot be established or its presentation would exceed
the limit. Late progress cannot reopen a terminal tool; authoritative results may
still correct its content. A tool without a result is marked interrupted without
replacing its last displayed output. Only an announced result without a matching
durable record fails a completed prompt.

Each tool retains at most 64 Ki characters and 512 chunks of presentation state.
Truncation is visible, and detected live output sequence gaps are marked. A
prompt may retain at most 1 Mi characters and 4096 tool identities; exceeding
either limit deliberately fails projection, rather than discarding another tool's
presentation. Terminal delivery
releases large payloads and retains bounded identity/digest information.

Before `turn.start`, the Session channel captures a transcript watermark. On
settlement and before successful prompt completion it rereads the target Turn to
the announced upper watermark, using the same subscription's paged transcript and
fragment decoder (the existing 16 MiB range assembly budget applies). Recovery
invalidates reads from the old subscription and starts again at the original cut.
This does not consume another subscription slot. Missing announced results, failed
reads and failed notifications prevent `end_turn`; cancellation and failed Turns
do not wait for missing results. An explicit cancellation still returns `cancelled`
if a notification had already failed. Only the channel decides Turn terminal state; the
registry waits for final projection delivery before returning `end_turn`.
