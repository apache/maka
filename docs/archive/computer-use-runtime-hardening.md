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

# Computer Use Runtime Hardening

This follow-up addresses lifecycle gaps found during review of PR #892.

## Problems

- `clearSession()` did not create a stop tombstone when no session-state record
  existed yet, so a first queued invocation could activate after cleanup.
- Read-only host actions did not acquire a session lease and could continue
  after `user_stopped`.
- Later lifecycle events could overwrite `blocked_url` or `user_stopped`.
- A process-wide executor queue blocked unrelated windows, while a first
  per-session replacement allowed two sessions to interleave
  snapshot/validation/dispatch against the same window.
- The ambiguity gate included ephemeral element IDs even when a stable element
  identity was available.
- `cursor_position` formatting existed without a production backend result.
- Service release reasons did not distinguish a session-only notification from
  a real child-generation release, so `clearSession(A)` could discard retained
  observations and keyboard ownership for unrelated session B.

## Root Cause

The Runtime treated observation and mutation leases as the only operations that
needed lifecycle fencing. Cleanup also mutated only an already-created state
record, while terminal transitions shared the same unrestricted transition
helper as recoverable states.

The executor queue was scoped to the caller rather than the resource being
validated. Ambiguity signatures also mixed stable identity with snapshot-local
IDs, and the cursor result test used only a fake backend.

The backend also inferred generation loss from the release reason. The
no-in-flight `clearSession()` path emits `session_cleared` without stopping the
child, so the reason alone cannot establish that shared executor state changed.

## Fix

- Create the same-turn stop tombstone unconditionally during `clearSession()`.
- Require an observation lease for every host-reading or waiting action.
- Make `blocked_url` and `user_stopped` absorb later lifecycle events.
- Serialize mutations by bound PID/window, with one conservative queue for
  unbound mutations; unrelated bound windows may still progress independently.
- Ignore ephemeral element IDs when a stable element identity is present.
- Read `get_cursor_position` through the pinned cua-driver and return the
  resolved point without moving the pointer.
- Carry `generationReleased` as an explicit service release fact. Session-only
  releases invalidate only their listed sessions; actual child exits sweep all
  retained session observations and keyboard targets.

A new turn still creates a fresh Computer Use session state, preserving the
existing explicit recovery boundary.

## Verification

- `npm --workspace @maka/runtime run typecheck`
- `npm --workspace @maka/runtime test`
- `npm --workspace @maka/computer-use test`
- `git diff --check`
