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

# Maka application client

Owns first-party Host calls and client data independently of the view framework.
The launcher supplies an already authenticated `host::Client`, a client-owned
`Journal`, and the explicitly exposed original receipt endpoint. UI code receives
operations on that scope; opening arbitrary Host Roots or journal files remains
the launcher's responsibility.

A mutation reserves its caller-selected attempt ID, receives the Host's original
preparation, commits that reference to SQLite, and then permits confirmation.
Reusing the attempt ID always requires recovery. Recovery reads the exact original
receipt, including after reconnecting with a new session; it never calls the
business method again. A missing or unknown receipt preserves the user's draft.
An explicit `abandon_unprepared` can fence an attempt before preparation commits.
It races the preparation's SQL update atomically, so an old background task cannot
later confirm an attempt the user ended. Prepared attempts retain their reference
and require recovery. Abandoned attempt IDs remain reserved permanently.

The shell retains the client scope independently of JavaScript handles. Cancelled
observers leave their original physical calls in that scope. Successful cleanup
releases each request; disconnected requests remain until the original session
acknowledges `close`. Recovering a business receipt alone does not settle a physical
request. Retained subscriptions do not impose a request-count ceiling on new
queries or controls. Each call retains its transport backpressure and cleanup
ownership; closing the scope fences admission and drains all accepted calls.

Drafts belong to the actual Host domain/deployment, captured provider/export,
session and stable editor ID. Saves compare the previous edit revision. Sending
atomically freezes that exact revision in the original operation journal and
consumes the editor's draft, so a new draft can be written while confirmation is
pending. The pending-send index retains only operation identities; it neither
copies message bodies nor schedules delivery. Confirmation reads the frozen
snapshot. Failed or stopped-before-delivery messages remain independently
recoverable without overwriting a newer draft. Queued receipts remain indexed
until the Agent confirms delivery, cancellation, or the user dismisses them.

Before a session exists, the desktop composer keeps its recent folders, unsent text and immutable file snapshots in the same journal, scoped to the admitted Host domain, deployment and Agent provider/export. Revision checks prevent a second window from overwriting it. Text edits do not rewrite file bytes. This local presentation state does not create a Host session or authorize a directory; the Host validates the saved selection again when it is used.

Tests cover reconnect recovery, cancelled preparation, storage failure,
subscription cleanup and draft edits racing a returned send.
