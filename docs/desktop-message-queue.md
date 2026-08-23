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

# Desktop Message Queue

## Problem

Desktop used a rendered `streaming` prop to decide whether a composer submit
started a root turn or steered the active turn. Immediately after the first
send completed its IPC round trip, the Runtime Host could already own an
active turn while React had not rendered the new `streaming` value yet. A
second submit in that interval entered the root-turn path and could fail with
`session_busy`. Multiple burst submissions also produced duplicate error
toasts.

Runtime Host already owns the durable message semantics:

- `current_turn` queues steering for the next provider boundary.
- `next_turn` queues a successor turn.
- queue projections are authoritative.
- `queue.retract` returns the queued message content.

## Desktop Behavior

- The default follow-up mode is Queue.
- While a turn is active, the composer exposes Queue and Steer.
- `Shift+Enter` uses the opposite mode for one submission.
- Queue and Steer both submit through `turn.message.submit`.
- The composer renders Runtime Host queue projections and can retract all
  queued messages back into the draft.
- Identical active toasts reuse one toast instead of stacking duplicates.

## Race Fix

Submission routing reads the synchronous live-turn ref and the latest session
catalog snapshot at the instant of submission. It does not rely only on the
previous React render.

## Deliberate Scope

This change does not add queue mutation operations such as editing, deleting a
single entry, reordering, promoting, or pause/resume. Those require additional
Runtime Host protocol and durability work and should be reviewed separately.
