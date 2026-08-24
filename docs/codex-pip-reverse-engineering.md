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

# Codex picture-in-picture reverse engineering

What Maka's Computer Use mirror copies from Codex, where each fact came from,
and the four places Maka deliberately does something else. It keeps confirmed
native facts separate from implementation inference, the same way
[computer-use-cursor-provenance.md](./computer-use-cursor-provenance.md)
does.

## Inspected artifacts

Two, and the split between them matters more than either one.

| | path | holds |
|---|---|---|
| service | `~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService` | the capture and publish half |
| host | `/Applications/ChatGPT.app/Contents/Resources/native/sky.node` | the window half |
| main JS | `/Applications/ChatGPT.app/Contents/Resources/app.asar` → `.vite/build/main-Be_0DBuv.js` | host registration |

The service has `RemoteHostedPIPContentPublisher`,
`RemoteHostedPIPCaptureStream` and `CUAServiceRemoteHostedPIPController`, links
AVFoundation and ScreenCaptureKit, and uses `AVSampleBufferDisplayLayer` — but
does **not** link AVKit. It captures and publishes over XPC; it does not host a
window.

The window lives in ChatGPT's own native addon, `sky.node`, in the `PIPStack*`
family. Searching only the service for a window symbol and concluding it does
not exist is a mistake this document exists partly to prevent: `RemoteHosted` in
a class name says the other half is in another process, so find that process
before concluding anything is absent.

## Confirmed: the panel

From `RemoteHostedPIPContentCreateStackPanel`, read out of the disassembly
instruction by instruction:

```objc
NSPanel initWithContentRect:… styleMask:0x80   // NSWindowStyleMaskNonactivatingPanel
                             backing:2 defer:NO
setTitle:
setBackgroundColor: [NSColor clearColor]
setOpaque: NO
setHasShadow: NO
setLevel: 0                       // NSNormalWindowLevel — deliberately not floating
setAcceptsMouseMovedEvents: YES
setCollectionBehavior: 0x108      // FullScreenAuxiliary | Transient
setHidesOnDeactivate: NO
setMovableByWindowBackground: NO  // dragging is hand-rolled, see below
```

and then `addChildWindow:ordered:`, from
`-[PIPStackWindow attachToOwnerWindowForPositioning]`.

The two facts that carry the whole design are `setLevel: 0` and
`addChildWindow:`. A child window is ordered against its parent rather than
against the desktop, and is carried by its parent inside one window-server
transaction.

## Confirmed: the structures

```
PIPStackHost      { hostID, ownerWindow, anchorContentRect, anchors[], presentationScope }
PIPStackHostAnchor{ contentPoint, alignment }
PIPStackWindow    attachToHost: / startFollowingOwnerWindow / ownerWindowFrameMayHaveChanged:
PIPStackController
    drag    beginDragAtContentPoint: → dragToContentPoint: → endDrag
    snap    nearestTargetAnchorForCurrentAnchor:draggingVelocity: → moveStackToAnchorAlongCurve:
    motion  configureMotionSpringsWithLeadItem:dragging:programmaticMove:
    hosts   moveStackToHostID: / compatibleAnchorsIncludingDragHosts:
    clamp   clampEnvelopeToVisibleScreen:
PIPStackItemMotion{ springStiffness, springDamping, velocity, target, origin, restOffset }
PIPStackContentView
    reinstallMouseEventMonitors → addGlobalMonitorForEventsMatchingMask:handler:
                                  addLocalMonitorForEventsMatchingMask:handler:
    updateHoverFromCurrentMouseLocation / contentPointForCurrentMouseLocation
```

`ownerWindowFrameMayHaveChanged:` reads `notification.object` and compares
`notification.name`, so it is a notification handler for the owner window's
move/resize. It recomputes the anchor. It does not move the window — the window
server does that, because the panel is a child.

## Confirmed: the constants

**Springs**, from `configureMotionSpringsWithLeadItem:dragging:programmaticMove:`
— one `cmp w26, #0` followed by four `fcsel`, so two columns of four:

| | not dragging | dragging |
|---|---|---|
| lead stiffness | 320 | 900 |
| lead damping | 42 | 55 |
| follower stiffness base | 150 | 260 |
| follower damping base | 30 | 32 |

with the follower values divided by `1 + 0.18·s` and `1 + 0.08·s` where
`s = |index| · (1 + 0.45·|index|)`.

The damping ratios are the reason those numbers and not others: settling is
ζ ≈ 1.17, just overdamped, so it never bounces past the corner it lands on;
dragging is ζ ≈ 0.92, just under critical, so the window keeps a trace of give
while the pointer pulls it.

**Throw**, from `nearestTargetAnchorForCurrentAnchor:draggingVelocity:`:

```
throw   = velocity * 0.55
t       = min(|throw| / 5000, 0.45)
target  = currentAnchor + unit(throw) * t
score(a)= |a.point − target| − |throw| · max(0, dot(unit(throw), unit(a.point − current)))
pick min score
```

and separately `hypot(velocity) >= 120` decides whether anchors on other hosts
are candidates at all.

The 0.55 is the difference between "the window goes where you threw it" and
"the window goes where you were pointing", and only the first feels like it has
weight. The dot-product term is what makes a deliberate throw across the window
land where it was aimed; distance alone picks the corner you are leaving.

**Size**: default longest edge 200pt, clamped to [100, 400], aspect preserved by
scaling to the shorter edge. Anchor inset 24pt. The three bounds are the
literal doubles `0x4069…`, `0x4059…`, `0x4079…`.

**Resize**, from `-[PIPStackResizeInteraction maxDisplaySizeForPointerScreenPoint:]`,
which is four instructions:

```
sign = (alignment & ~1) == 2 ? +1 : -1
size = initialMaxDisplaySize + (pointer.y - initialPointer.y) * sign
```

Only the vertical component moves it, and the sign comes from the corner the
mirror rests on, so the gesture reads the same everywhere: away from the anchor
grows it. Nothing is incremental — the interaction keeps the edge and pointer
height it started from — so a jittery pointer cannot accumulate drift.

**Controls**: `performControlWithIdentifier:` takes `stop`, `hide`, `close`;
`setHoveredControlIdentifier:` and `_pressedControlIdentifier` drive their
appearance.

## Measured on Electron 43, before writing any of it

| | result |
|---|---|
| `documentPictureInPicture` | `undefined`, with and without `--enable-features=DocumentPictureInPictureAPI` |
| child window, parent moves | child follows, no code, same transaction |
| child window, parent resizes | child does not move — the anchor needs recomputing |
| child window `isAlwaysOnTop()` | `false` |
| child window focus | never taken |
| injected mouse events into a click-through window | delivered, but coalesced — 2 of 5, then 1 of 5 |

Document Picture-in-Picture is not merely disabled in Electron; its
implementation lives in Chromium's `//chrome` browser layer
(`PictureInPictureWindowManager`), which Electron does not have. That road is
closed, not narrow.

## What Maka copies

- Child window of the app window, at normal level. Both of the mirror's original
  faults — floating above unrelated apps, and trailing a frame behind during a
  drag — were one cause: positioning itself instead of being carried.
- `hasShadow: false`. `pip.html` draws its own; the native shadow would be a
  second one, recomputed by the window server from the content's alpha every
  time a frame lands, on the one window that receives a frame after every action.
- 200pt default edge, [100, 400] clamp, 24pt inset.
- The spring constants, the throw projection and the anchor scoring, in
  `apps/desktop/src/main/computer-use/pip-motion.ts`, with the disassembly
  quoted next to each constant.
- Hover decided from the pointer on the main side, because that is what Codex's
  global and local `NSEvent` monitors do. It never asks the window whether the
  pointer is inside it.
- Only resizes are acted on. A move is the window server's job.

## Where Maka does something else, and why

**Two controls, not three.** Codex's `close` dismisses one tile and `hide`
dismisses the stack. Maka mirrors one window at a time, so those are the same
gesture and only one of them earns a button.

**Click-through until pointed at.** Codex's tile always takes the click:
`acceptsFirstMouse:` returns YES and `hitTest:` claims the whole view. Its tile
is opt-in behind a setting worded "Show backgrounded apps that Computer Use is
working on in Picture-in-Picture mode"; Maka's appears whenever a run starts, so
it has to cost nothing to ignore. `setIgnoreMouseEvents(true, {forward: true})`
still delivers moves, so main can tell when to take the clicks back.

**No stack.** Codex mirrors several tiles with a lead item and followers; the
follower spring column and its index falloff have nothing to apply to here.

**The grip appears with the controls.** Codex's resize handles are part of the
same hover chrome; at rest the tile carries none. Same here — a 200pt window
cannot afford permanent affordances.

**Frames, not video.** Codex streams via ScreenCaptureKit across XPC. Every
mutating Computer Use action already returns a screenshot of the target,
captured after the settle wait, so the mirror is a flipbook of post-action
frames and costs no extra capture. The trade is real and deliberate: between
actions, the mirror does not update.

**No cross-host move.** `moveStackToHostID:` moves the stack between *owner
windows* — Codex registers several hosts, including `avatar-overlay`. Maka has
one window, so there is nothing to move between. Cross-display works because the
mirror is the app window's child and goes wherever that window goes.

## Verification

`scripts/pip-interaction-smoke.mjs` runs the real thing: a real parent window, a
real child panel, the real preload and renderer, real input events. It asserts
the child-window properties, the seat position, the carry-on-move, hover, a
throw settling on the anchor it was aimed at, an app resize returning the mirror
to the chosen corner rather than the default one, a grip drag growing it
(measured 200x160 → 290x232, aspect held, still on its corner, inside the
clamp), and the hide control.

It needs no accessibility and no unlocked screen — it drives Electron windows
only — which makes it the one real-machine check that keeps working when the
rest cannot run.

The physics and the anchor scoring are covered exactly, without a desktop, in
`apps/desktop/src/main/__tests__/computer-use-pip-motion.test.ts`.
