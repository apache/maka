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

# PR3 Goal wait upgrade fixture

`legacy-goal-event-waits.json` contains rows produced by Maka commit
`b0ed5707ff3dc645c66253ed93e50936e3f9d45d` (PR #6147), using that commit's
`localExecutionPersistenceProvider`, Goal authority, event-wait bridge and
Runtime event writer. Session IDs and temporary root paths were replaced with
`legacy-session` and `/legacy-root`. The fixture is Apache-2.0 project test data.

The producer admitted a source Turn, appended its invocation opening, prompt and
12-token usage fact, and called `registerGoalWait`. It saved snapshots after:

- `registered`: registration before the source terminal event;
- `unsettled`: source completion with `stopReason: event_wait`, before settlement;
- `waiting`: `settleGoalWait`, with one iteration and 12 tokens accounted;
- `queued`: resolution and `queueGoalWait`, before successor admission;
- `admitted`: successor `admitRootTurn`, before its invocation opening;
- `completed`: successor opening, prompt with the old `eventWait` origin,
  completion and an achieved Goal;
- `suppressed`: pausing the Goal through the old authority writer, which cancels
  and suppresses its wait.

`schema` is the original workflow-15 wait table and indexes. Tests install these
rows into an otherwise current empty Session, exercise the production database
opener and full Host recovery, and also cover roots advanced to workflow 16.
The fixture tests storage and recovery boundaries; it does not simulate the old
model's tool selection or external event source.
