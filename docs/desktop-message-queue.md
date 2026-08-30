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

Desktop used a rendered `streaming` prop to decide whether a composer submit started a root turn or steered the active turn. Immediately after the first send completed its IPC round trip, the Runtime Host could already own an active turn while React had not rendered the new `streaming` value yet. A second submit in that interval entered the root-turn path and could fail with `session_busy`. Multiple burst submissions also produced duplicate error toasts.

Runtime Host already owns the durable message semantics:

- `current_turn` queues steering for the next provider boundary.
- `next_turn` queues one successor turn per accepted message.
- queue projections are authoritative.
- queue projections carry the canonical queued message content; mutation results return only queue state.

## Desktop Behavior

- While a turn is active, a composer submit queues a follow-up. There is no mode switch: Send is always Send.
- `Shift+Enter` steers the draft into the active turn once.
- Queued messages render in a pending plate above the composer card, in send order (first at the top). Per entry the plate offers:
  - drag the hover grip to reorder the follow-up queue,
  - promote (立即发送) to steer the entry into the active turn,
  - retract (收回草稿) to restore the entry into the composer draft.
- Queue contents and mutations are Runtime Host operations (`turn.message.submit`, `queue.entry.promote`, `queue.entry.retract`, `queue.entries.reorder`); the renderer mirrors the authoritative projection.
- Identical active toasts reuse one toast instead of stacking duplicates.

## Race Fix

Submission routing reads the synchronous live-turn ref and the latest session catalog snapshot at the instant of submission. It does not rely only on the previous React render.

## Deliberate Scope

Per-entry queue mutation is limited to reorder, promote-to-steering, and retract-to-draft. Editing a queued entry in place, pausing the queue, and cross-session moves still require separate Runtime Host protocol and durability review.
