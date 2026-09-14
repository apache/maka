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

Interaction mapping remains deferred to the next ACP capability increment. If a
pending permission, question, form, sandbox-boundary, or client-capability request
belongs to an active ACP prompt, the adapter rejects it with JSON-RPC `-32603` and
`error.data.code: unsupported_interaction` (`error.data.kind` identifies the request).
It retires the attachment and uses the existing failure path to request Stop for
that prompt's exact Host Turn. It does not answer or approve the interaction;
Host remains responsible for settlement. A failed Stop retains the Host diagnostic.
The durable Session remains owned and can be prompted again or closed.
Interactions belonging to another client's Turn keep the idle attachment available
so ACP cancellation and close can still stop the observed root.
