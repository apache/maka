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

# Drag-to-grant permission onboarding (macOS)

Status: **Stage 1 built** (`apps/desktop/src/main/permission-overlay/`,
`apps/desktop/src/overlay/permission-overlay.*`). Stage 2 is still a proposal.
Written 2026-07-27 for maka.

## The problem

macOS gates Accessibility and Screen Recording behind TCC, and the stock
flow is hostile: the user must open System Settings, find Privacy &
Security, find the right pane, press `+`, navigate a file picker to
`/Applications`, choose `Maka.app`, then come back and tick a checkbox.
Six steps, and the file picker is where most people give up.

maka today does the honest-but-minimal thing: `permissions-actions.ts`
deep-links into the right pane and stops there
(`apps/desktop/src/main/permissions-actions.ts:52`). Everything after the
deep link is on the user.

Apple's design intent is that the user *explicitly* adds the app — that
part is not worth circumventing. But System Settings also accepts an
`.app` bundle **dropped** onto the permission list, which satisfies the
same intent in one gesture. That is the whole trick.

## What we're copying, and from where

Two independent implementations of the same idea:

- [`riko2chen/AskForPermission`](https://github.com/riko2chen/AskForPermission)
  — MIT, native Swift/AppKit. Not directly usable (maka is Electron) but
  its window-location approach is the correct one.
- Alma (closed-source; behaviour observed in the local `~/alma-re`
  study archive). Electron, so its shape maps onto maka almost directly.

**We take the technique, not the code.** No Alma source is copied into
this repo, and `~/alma-re` stays out of the tree.

## The mechanism

Four APIs, only one of which is exotic:

| Piece | API | Notes |
|---|---|---|
| Non-focus-stealing card | `BrowserWindow` `{type:'panel', focusable:false, transparent:true, frame:false}` + `setAlwaysOnTop(true,'screen-saver')` + `showInactive()` | All four are load-bearing. Drop any one and the card steals focus, which drops System Settings' drop-target highlight mid-drag. |
| Follows the Settings window | `CGWindowListCopyWindowInfo` | **Not reachable from Electron** — see below. |
| The drag itself | `webContents.startDrag({file, icon})` | Stock Electron. Writes a `kUTTypeFileURL` onto `NSPasteboard`, which is what makes the drop legible to another process. An HTML5 `dragstart` cannot cross the process boundary. |
| Grant detection | `systemPreferences.isTrustedAccessibilityClient(false)` / `getMediaAccessStatus('screen')` on a ~1.5s poll | There is no usable notification for these; polling is the state of the art. |

### The one hard constraint

Electron exposes no API for another application's window geometry —
`screen.*` covers displays and the cursor only. The single
permission-free source on macOS is `CGWindowListCopyWindowInfo`: window
*images* require Screen Recording, but the *metadata* (`kCGWindowBounds`,
`kCGWindowOwnerPID`) does not. That distinction is what avoids the
chicken-and-egg of asking for Accessibility using an API that itself
requires Accessibility.

Explicitly ruled out: `osascript` / System Events
(`get position of window 1 of process "System Settings"`) needs both
Accessibility and an Automation grant — exactly the deadlock we're
trying to escape.

So the docking effect costs one native call. Three ways to get it:

1. **Prebuilt Swift CLI in `Resources/`, spawned as a child process.**
   ~50KB universal binary, signed and notarised with the app. No
   node-gyp, no N-API/ABI coupling, cannot crash the main process.
   **Recommended.**
2. **Compile Swift at runtime on first use, cache the binary.** Alma's
   approach. Zero build-system work, but it hard-depends on Xcode
   Command Line Tools at runtime — absent on most non-developer Macs —
   and Alma's version fails *silently* when they are.
3. **Node addon (koffi / N-API).** Avoids a process spawn per tick, but
   buys ABI coupling and a rebuild every Electron bump for a call made
   ~5×/second. Not worth it.

Note the cost model in (1) and (2): a tracker polling at 200ms spawns a
process 5×/second for the life of the overlay. Acceptable for a
short-lived onboarding overlay; it should not become a general facility.

## Staging

**Stage 1 — pure Electron, no native code. DONE.** Everything except
docking: the panel window, the deep link, the drag, the poller, the
grant→close lifecycle, the copy. The card anchors to
`screen.getCursorScreenPoint()`, clamped into that display's work area —
the user just clicked our button, so the cursor is a good proxy for where
they are looking, and it lands on the display they are actually using.

Entry point is 引导授权 / "Guide me" in Settings → 权限与能力, shown only
for the two drag-to-grant permissions and only where `canOpenSettings`
is true (main sets it on darwin alone). The plain "open System Settings"
link stays beside it — the drag is a shortcut, never the only route.

The lifecycle lives in `permission-overlay-controller.ts`, fully injected
and covered by `permission-overlay-controller.test.ts` with a fake clock:
no window or timer stacking on re-entry, teardown on grant / dismiss /
window-gone, and a give-up timeout so an abandoned flow cannot leave an
immortal always-on-top card (a hole both reference implementations have).

**Stage 2 — add the locator binary** as progressive enhancement. Not built. When it
returns a frame, the card docks to the Settings window and follows it;
when it returns `null`, fall back to the Stage 1 anchor. Unlike Alma,
log the degradation loudly — a silent fallback is indistinguishable
from a bug.

## Stage 2 landmine: the two coordinate spaces do not match

The reference locator returns **AppKit** coordinates — origin bottom-left
of the containing screen:

```swift
y = screen.frame.maxY - localY - cgFrame.height
```

with a comment claiming that is what `setBounds` expects. It is not.
Electron normalises screen coordinates to **top-left** origin on macOS,
so feeding it a bottom-left `y` is a space mismatch. The docking math
then adds a small offset (`y = frame.y + 14`) meaning "just below the
window top", and the two spaces agree only when

```
screenHeight - windowTop - windowHeight  ==  windowTop
```

i.e. only when the Settings window is **vertically centred** — which is
exactly where it opens by default, so the bug is invisible in a demo.
Worked through for a 900px screen and a 600px window:

| Settings window top | y passed to setBounds | intended | drift |
|---:|---:|---:|---:|
| 60  | 254 | 74  | **+180** |
| 150 (centred) | 164 | 164 | 0 |
| 250 | 64  | 264 | **−200** |

So the card is correctly placed until the user moves the Settings window,
then slides the wrong way by twice the displacement.

Stage 2 must either return CG (top-left) coordinates and skip the AppKit
conversion entirely, or convert and then convert back. Whichever we pick,
the tracker needs a test that moves the window off-centre — a fixture
using the default position proves nothing.

## Design notes worth stealing

- **The drag image should look like the destination row**, not like the
  app icon: a small canvas-rendered replica of a System Settings list
  row (icon + "Maka"). What you drag looks like what it becomes, which
  is what makes the gesture read as obvious.
- **Flight animation:** quadratic Bézier with the control point lifted
  `clamp(0.18 × distance, 44, 140)`px, over ~720ms on a critically
  damped spring. The arc is what signals "this belongs over there".
  Skip it in Stage 1 — with no real target it is decoration. Gate it on
  `prefers-reduced-motion` either way.
- **Screen Recording needs an extra beat:** macOS caches the old denial,
  so a freshly granted app often still reads `denied`. The honest fix is
  copy — after ~8s, tell the user a relaunch is required.

## Gaps to fix rather than inherit

Both references have holes worth not copying:

- **No detection that the user closed System Settings or gave up.** The
  card just freezes in place, always-on-top across every Space, until
  it is dismissed by hand. maka should treat "Settings went away" and a
  give-up timeout as real states.
- **No dev-mode affordance.** When there is no `.app` to drag, the
  mousedown silently does nothing. Fall back to "reveal in Finder" or a
  copy-path button so the flow degrades to something usable.
- **Stacked pollers.** Alma pushes a new subscriber and restarts the
  tracker on each entry point, so two paths onto the same window stack
  duplicate timers. One tracker per window, owned by the window.

## Scope

Roughly: one main-process module (window + tracker + lifecycle), one IPC
channel for the drag, one renderer route for the card, copy in both
locales, plus Stage 2's locator binary and its build/signing step.
`apps/desktop/src/main/computer-use/cursor-overlay-window.ts` already
does transparent / always-on-top / all-workspaces / `showInactive` and
is the right thing to model the window on — possibly to generalise.

This is its own PR, separate from any settings-control work.
