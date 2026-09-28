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

The renderer once selected root-turn versus active-turn submission from the last rendered `streaming` value. Runtime Host ownership can advance before React commits that projection, so a second message could take the stale root-turn path and fail with `session_busy`. Burst sends could also fan out the same failure through multiple toasts.

Runtime Host already owns the durable message semantics:

- `current_turn` queues steering for the next provider boundary.
- `next_turn` queues one successor turn per accepted message.
- queue projections are authoritative.
- projections contain canonical queue entries; commands acknowledge only the committed queue revision.

## Desktop Behavior

- Ordinary submission during an active turn creates a follow-up. Steering remains an explicit shortcut rather than a persistent composer mode.
- `Cmd+Enter` on macOS (`Ctrl+Enter` on Windows/Linux) steers the draft into the active turn once; while idle it sends normally.
- `Shift+Enter` and `Alt+Enter` always insert a line break, including during an active turn.
- The pending plate renders the Host order above the composer. A queued row can be edited, reordered within its lane, promoted from follow-up to steering, or retracted.
- Runtime Host owns submission and mutation (`turn.message.submit`, `queue.entry.update`, `queue.entry.promote`, `queue.entry.retract`, and `queue.entries.reorder`). The renderer never invents a local queue order.
- Identical active toasts reuse one toast instead of stacking duplicates.

## Race Fix

At submission time Desktop consults the live-turn reference together with the latest catalog projection. The decision therefore does not wait for another React commit.

## Deliberate Scope

Mutation remains lane-local. Pausing delivery or moving an entry between sessions would require new Host protocol and durability semantics.
