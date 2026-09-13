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

# Computer Use Physical-Input Guard

## Reported Symptom

During the no-focus process-restart soak, the user's pointer did not move and
the synthetic fixture never became frontmost. The user still observed
occasional abnormal physical clicking while continuing to use the Mac.

The symptom cannot be dismissed as general system load. The Computer Use pixel
path posts mouse down/up events to a target PID. Those events do not warp the
real cursor, but they can still interleave with physical mouse events in the
system and application event queues.

## Root Cause

Runtime already models physical intervention:

```text
physical input
  -> user_intervened
  -> invalidate the observation
  -> require a new observation
```

Desktop did not provide a real macOS physical-input producer or pre-dispatch
guard. The concurrent E2E allowed user input while the backend continued to
dispatch target-PID mouse events.

## Final Fix

Desktop supplies a host-owned guard using:

```ts
powerMonitor.getSystemIdleTime() < 1
```

Electron reports whole idle seconds, so this is a conservative approximately
one-second quiet window rather than a precise millisecond deadline.

The backend checks the guard at the last practical boundary before every
mouse, keyboard, semantic, scroll, drag, or text dispatch. If input is active,
or if the guard cannot establish the idle state, it returns:

```text
user_intervened
```

No cua-driver input tool is called. Runtime invalidates the consumed
observation and requires an explicit new observation before another action.

Live testing then proved the quiet window alone was not a sufficient safety
claim: PID-bound CGEvent mouse delivery can still interfere with physical
button state when the user and agent overlap.

The production policy therefore also disables the compatibility event backend
by default:

- coordinate click, right/middle/double/triple click: blocked;
- scroll and drag: blocked;
- `press_key`: blocked;
- semantic action fallback to pixel: blocked.

The retained paths are:

- observation, screenshots, wait, zoom, and virtual cursor presentation;
- native AX element actions and `set_value`;
- uniquely targeted Electron CDP semantic actions and `insertText`.

Compatibility dispatch can only be re-enabled through an explicit backend
option used by controlled tests. Desktop does not set that option.

## Verification

Unit and integration coverage proves:

- coordinate and semantic input return `user_intervened`;
- no `click` call reaches cua-driver;
- no dispatch trace is emitted for a guarded action;
- selector and Desktop host wiring preserve the guard;
- the Desktop production source uses the Electron idle-time signal;
- existing Computer Use behavior remains green.

The real restart soak no longer emits compatibility mouse or keyboard events.
It proves stale-process rejection and fresh-process recovery with native AX
`set_value` plus exact state readback. Physical-input fencing remains covered
by unit/integration tests without synthesizing global HID events.

The soak still launches and orders a real visible AppKit fixture window.
`open -g` avoids explicit activation, but launch can remain noticeable and may
perturb WindowServer responsiveness. It is not a zero-disturbance
background-run proof.

## Remaining Boundary

Re-enabling coordinate input requires a native executor that can prove its
event backend does not affect global physical button state. A host-side quiet
window alone is not sufficient evidence.
