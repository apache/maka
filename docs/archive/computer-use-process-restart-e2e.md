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

# Computer Use Process-Restart E2E

## Goal

Prove that a Computer Use observation from one live application process cannot
authorize an action after the same canonical application path is relaunched as
a new process.

The expected lifetime follows the recovered Codex boundary:

```text
canonical application path
  + current live process instance
```

Conversation or transport continuity must not extend an observation across a
real target-process restart.

## Incident And Investigation

The first real-machine harness attempts exposed several independent test
assumptions before reaching the process boundary:

1. A fresh worktree had no workspace `node_modules`, so downstream packages
   could not resolve `@maka/core`. Running `npm ci` established the same
   dependency layout used by CI.
2. The ignored cua-driver artifact was absent in the new worktree. The launcher
   now runs `prepare:cua-driver` and then verifies the pinned artifact before
   starting the fixture.
3. WKWebView AX nodes can appear late and can be mirrored with duplicate labels
   and different frames. The restart gate therefore uses the native
   `CUA Lab Coordinate Target`; OOP behavior remains covered by the dedicated
   guarded E2E.
4. Activating the fixture made the test pass but stole the user's focus.
   `open -g` avoided activation but kept the app hidden from the driver's
   on-screen window set. The final fixture mode uses LaunchServices background
   launch plus `unhideWithoutActivation`, `moveToActiveSpace`, and
   `orderFrontRegardless` so the window is on-screen without becoming the
   frontmost application.
5. Runtime tool failures are projected through model-visible text rather than a
   top-level `error` property. The gate verifies both the backend typed outcome
   and the model-visible `target_missing` result.

These were harness defects or environment prerequisites. None dispatched an
action before the target-process identity gate was reached.

## Real Sequence

The launcher and harness keep one cua-driver backend and one Runtime tool
instance alive across five target restarts:

```text
repeat 5 times with one backend/Runtime instance:
  -> observe current PID/window
  -> bind coordinate action
  -> terminate current app
  -> launch same canonical app path
  -> require globally new host PID and WebContent PID
  -> attempt old observation
  -> require target_missing, no dispatch, mutation 0 -> 0
  -> clear session
  -> observe new PID/window
  -> execute fresh native AX set_value action
  -> if visible, require exact readback on the new process
  -> if covered by the user's window, require target_occluded and zero mutation
  -> require cua-driver generations stable and restartAttempts == 0
```

The launcher owns sleep prevention, fixture cleanup, bounded child
termination, and private temporary handshake/report files. The synthetic app
is launched with `CUA_LAB_BACKGROUND=1`. In that mode the fixture orders its
window visible without activating the application or making it the user's
frontmost app. A continuous Swift sentinel allows the user to switch among
their own applications, type, and move the pointer, but fails immediately if
the synthetic fixture ever becomes frontmost or the screen locks. Cleanup
preserves the user's current application; restoration is only an emergency
path if the fixture itself stole focus.

The fixture is still a real visible AppKit window. Background launch avoids
explicit activation, but window creation and `orderFrontRegardless` can remain
noticeable and can perturb WindowServer responsiveness. This is an attended
release test, not a zero-disturbance background-run proof.

Physical user pointer movement is allowed and reported as observation data.
When the user's window occludes the target, the stronger non-interference
proof is that the backend emits no dispatch and both target and decoy mutation
remain zero.

## Historical Pixel Result

Before compatibility input was disabled, the July 14, 2026 five-round
no-focus pixel soak proved:

```text
restart rounds:             5
distinct host PIDs:         6
distinct WebContent PIDs:   6

old observation per round:
  outcome:                  target_missing
  native dispatch:          none
  target mutation:          0 -> 0

fresh observation:
  background px success:    4 rounds
  fail_closed_occluded:     1 round
  decoy mutation:           always 0 -> 0

cua-driver service:
  action generation:        1 throughout
  capture generation:       0 throughout
  restartAttempts:          0 throughout

desktop concurrency:
  fixture became frontmost: never
  user pointer moved:       151.2 logical points
  user app switching:       allowed
```

The occluded round proved:

```text
outcome:               target_occluded
native dispatch:       none
target mutation:       0 -> 0
decoy mutation:        0 -> 0
```

The test command is:

```bash
npm run computer-use -- real-ax --scenario restart-recovery
```

## Current AX-Only Result

The replacement soak uses AX `set_value`, not pixel input. The corrected
five-round run proved:

```text
restart rounds:             5
old observation:
  target_missing:           5/5
  native dispatch:          0

fresh observation:
  AX set_value + readback:  5/5

cua-driver service:
  action generation:        1 throughout
  capture generation:       0 throughout
  restartAttempts:          0 throughout

desktop concurrency:
  fixture became frontmost: never
  user pointer moved:       217.1 logical points
  user mouse/keyboard:      reported normal
```

The first AX-only attempt had already confirmed stale-process rejection and a
successful fresh AX mutation, but used the wrong external oracle: direct
AXValue mutation does not invoke the fixture's Cocoa callback that writes
`state.json`. The final run instead verified the fresh AX observation returned
by Runtime.

## Remaining Boundary

This proves ordinary process restart isolation. It does not force the operating
system to reuse the old numeric PID. PID-reuse safety still requires either:

- a native atomic process-instance identity exposed by the executor; or
- a deterministic driver/host fixture that can substitute a new process under
  the same PID-shaped identity.

The current fail-closed old-window lookup is sufficient for the observed real
restart, but it is not evidence for deliberate PID reuse.
