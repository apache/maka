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

## Local paused-message downgrade safety

The client can pause a never-dispatched local message for editing before the
Host owns it. In the local outbox, these records use `failed` in the SQLite
state column and retain `paused` in the JSON payload. Older readers use the
column, so their delivery workers skip the original instead of automatically
sending it. They may display it as a failed message. New readers recover the
paused state only when both values match this encoding; genuine failures remain
failures, and an explicit resume writes `saved` to both values.

This protects automatic dispatch of paused originals; it does not promise full
application downgrade compatibility or prevent explicit edits and deletion in an
older version.

## Local edit recovery

Editing a never-dispatched local message pauses its durable original first.
If the user navigates before recovery returns, the complete text, staged
attachments, directories, quotes and replacement identity return to the original
Session's draft, without changing the visible Session's content or focus.
The restore is conditional on the original draft staying unchanged: typing and
then clearing, adding and removing context (including pending Session references),
explicit clearing, Session deletion or ownership changes, and owner unmounts
invalidate the request. A refused restore releases only its unused temporary
approvals; the paused original remains recoverable. Successful sending atomically
replaces that original. Host-owned queue and failed-message recovery keep their
existing behavior.

Drafts linked to a paused original stay in memory, including their replacement
identity. Their text is not written to the optional draft persistence adapter:
restoring text alone after a restart would turn the edit into an unrelated new
message. After a restart, edit the saved original again to recover its text and
attachments. Unsent changes to the edit do not survive the restart.

Recovery attachment approvals expire after 30 minutes and are scoped to the
current recovery owner. If a send refuses an expired or unavailable source, the
draft stays intact. The error explains how to recover the attachments: copy text
edits, clear the draft and its context, then edit the original message again.
For mixed attachment sources, the error first asks users to remove and reselect
newly added files, then explains how to restore original attachments and re-add
other files if needed. The batch error does not identify which source expired.
The original's saved bytes remain available until explicit deletion or successful
atomic replacement.
