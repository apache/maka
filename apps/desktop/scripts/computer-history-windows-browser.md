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

# Windows Edge History Canary

This opt-in suite invokes the staged `open-history.exe snapshot` worker directly
from Node 24 in an unlocked Windows interactive session, then tests a real
recorder against a third, untouched browser profile. Run it sequentially,
not alongside other desktop-driving tests. It does not test summary generation
or the frontend.

```powershell
$env:MAKA_HISTORY_WINDOWS_BROWSER_TEST = '1'
$env:MAKA_HISTORY_WINDOWS_TEST_ROOT = 'C:\maka-history-lab'
node --test apps/desktop/scripts/computer-history-windows-browser.test.mjs
```

Optional absolute executable overrides:

```powershell
$env:MAKA_HISTORY_WINDOWS_HELPER = 'C:\path\to\open-history.exe'
$env:MAKA_HISTORY_WINDOWS_EDGE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

The default helper is `apps/desktop/resources/bin/open-history.exe`.
The test root must already exist on a local drive. No npm packages or Python
dependencies are needed. The companion PowerShell fixture uses Windows
PowerShell 5.1 and its bundled C# compiler for window identity/focus checks.
Startup retries missing or temporarily locked (`EBUSY`) `DevToolsActivePort`
reads within the same 20-second deadline. Other read errors fail immediately.

## Cases

| Case | Required result |
| --- | --- |
| Allowed localhost-served document | Actual body marker and Document origin |
| Same-origin navigation | Updated body; no old body, URL path, query or fragment |
| Blocked top-level domain | Entire snapshot is `null` |
| Allowed parent with a blocked cross-origin iframe | Entire snapshot is `null` |
| Same-input text/password/text transition | Plaintext value and body readable; password snapshot `null`; new plaintext value readable again |
| Same-page normal/private/normal title transition | Body readable; private-title snapshot `null`; updated body readable again |
| Text collection disabled | Admitted metadata only, no body |
| Text collection restored | Useful body again |
| Real fresh-profile `--inprivate` instance | Entire snapshot is `null` |
| Snapshot-only operation | No recorder runtime or segment files |
| Cold recorder and in-place DOM edit | Useful body without prior snapshot warm-up; updated body with the same source UUID; sealed segments and released ownership after EOF |

The eleven cases require useful text before and after regular suppression.
A failed positive baseline makes suppression
coverage inconclusive and fails those cases. A provider error, worker timeout
or forced termination is never counted as successful suppression. Case failures
are recorded individually so later cases still run where setup remains usable.
Domain-blocking cases first require the same document (including the iframe
body and origin) to be readable with that domain allowed. A cross-process
iframe that native cannot safely capture therefore fails coverage rather than
appearing to prove that the blocklist works. Domain cases navigate back to the
allowed page for recovery.
The iframe case also focuses the embedded document, requires both parent and
child bodies/domains to remain readable, then blocks only the parent domain
without navigating. Complete suppression and subsequent useful-body recovery
must hold while the iframe retains focus.

The password case never navigates between its three phases. It retains the
same document, DOM input and HWND; verifies a synthetic plaintext input value;
switches that input to password with a distinct denied-only value; then clears
the value before switching back to text with a new recovery value. Rejecting
every editor page cannot satisfy the positive controls. The title case likewise
retains its document, body element and HWND while changing a neutral title to
`InPrivate` and back. Its baseline page name is `title-state`, with no private
marker. Each phase verifies DOM state and foreground/window identity before
calling native; CDP content is never substituted for native output.

Denied-only password and title-body markers must be absent from native output,
including recovery and all subsequent snapshots. A suppressed snapshot must
still be exactly `null`, including no title or metadata. Synthetic inputs and
raw diagnostic evidence intentionally retain these markers for inspection.
The real InPrivate page uses the neutral title `isolated-session`; its own
document title contains no private-browsing marker. The separate private-title
case deliberately adds and removes such a marker.

The first allowed snapshot permits bounded retries of the same unchanged
document while Chromium initializes accessibility. Neither a separate AX
client nor navigation warms that document. The recorder case starts a third
fresh profile, never calls `snapshot` on it, and requires a useful persisted
body within 25 seconds. It then modifies the same DOM body, requiring a fresh
event within nine seconds, exact PID/HWND/domain, a nonempty source UUID equal
to the initial event, and no replaced text. Closing stdin must end the recorder
normally, seal complete JSONL with matching metadata, publish stopped runtime
and release its admission lock.

## Isolation

- Every browser launch uses a newly created, random `--user-data-dir`; it never
  attaches to a user's existing Edge profile or an existing debugging endpoint.
- The synthetic server binds only to `127.0.0.1`, uses a random port and path,
  and serves no external resources. `localhost` and `127.0.0.1` provide distinct
  origins. If local name resolution prevents iframe/page loading, readiness
  fails rather than counting missing content as a policy success.
- Consent applies only to a new test home. Application and URL defaults deny
  observation. Only `win32.msedge`, `localhost` and `127.0.0.1` are allowlisted;
  blocked-domain cases explicitly deny `localhost`.
- The first ten cases run only snapshots; the last case starts an explicitly
  consented recorder against the same isolated home. Every snapshot targets
  the exact directly spawned Edge PID and HWND after checking its executable, Node parent, profile
  command-line argument, synthetic title and current foreground identity.
- Foreground loss aborts that snapshot attempt. No global focus policy,
  permissions, registry, network proxy or security setting is changed.
- CDP only navigates, changes synthetic fixture state and verifies DOM readiness. It does not provide
  capture content, request accessibility trees, force accessibility flags,
  take screenshots, disable the browser sandbox or alter origin checks.
- The fixture disables GPU acceleration for compute-host execution; this only
  affects the launched browser, not a global browser or Windows setting.
- Cleanup closes only the launched profile through its own CDP endpoint. A
  failed graceful close triggers bounded termination of that still-owned
  process tree and fails the run. It never kills Edge by executable name.

The output path printed by the test retains `evidence.jsonl`, native stdout,
stderr, per-case timings, exact synthetic inputs and isolated profiles. These
are diagnostic artifacts, not a personal-history store. Do not publish the
profiles; review evidence before attaching it to an issue.

## Coverage Interpretation

The suite deliberately starts Edge without accessibility activation flags.
Some Edge/provider versions may not expose a web Document's own URL or may
exceed native traversal budgets. Those are reported as failed useful-body
coverage, not worked around by address-bar origin guesses or relaxed privacy
checks. A passing snapshot suite does not establish standard-user permission
support if it was run from an elevated Windows session. The initial helper
`status` launch is timed separately, before creating any browser profile,
so executable startup does not consume an individual UIA worker deadline.

## Measured Results

On September 15, 2026, Windows 11 build 26200, Edge `151.0.4129.93` and Node
24.18.1 passed all eleven cases in run `eazkDX`. The total was 65.40 seconds,
including 24.12 seconds for a newly staged executable's first `status` launch.
The unchanged cold page reached the recorder in 3.51 seconds, and the edited
body in 3.58 seconds with the same source UUID. All three isolated browser
processes and the recorder exited normally. The strengthened WinForms
regression also passed after the browser changes.

The stronger recorder-sealing run `6vofWh` passed ten cases but the allowed
iframe baseline hit the 700 ms worker budget (739.90 ms including launch).
This remains a recorded failure, not a successful denial. Combining fresh
nonsensitive type/framework and node-state reads reduced provider round trips
without changing deadlines or source checks. The separate lightweight
visibility request remains in sensitive-read fences. Run `nM5Evc` then passed
all eleven cases in 42.22 seconds; its iframe baseline took 655.45 ms versus
722.67 ms in `eazkDX`. These samples establish improvement, not a worst-case
latency guarantee for arbitrary pages.

The final `xj9Teh` run passed all eleven cases in 44.01 seconds, including
the added DOM iframe-focus/blocked-parent/recovery sequence and strict
recorder sealing assertions. Its cold body arrived in 3.53 seconds and its
same-window edit in 3.61 seconds. DOM focus is fixture ground truth; the
harness does not independently inspect the UIA focused-element object.

The initial launch delay occurs before native entry; its cause has not been
established or bypassed. Later helper launches are substantially shorter.
The reported recorder times exclude that separate first-executable launch.

Before adding document/text event subscriptions, run `GclUxV` captured a cold
body in 3.40 seconds but needed 15.58 seconds to observe the unchanged-window
edit. The final recorder uses existing WinEvent scheduling for IAccessible2
document/text events as well as reorder and text-selection notifications.
They invalidate a capture without carrying body data or rotating window
identity.

## Earlier Failures And Root Causes

Earlier whole-window runs (`QpHdiT`, `L9XMw9`, `QB16Fs`) failed all nine useful
semantic cases; only the no-recorder-files check passed. Those negative cases
remain inconclusive historical evidence, not privacy acceptance.

- An immediate browser child was an `Intermediate D3D Window` owned by Edge's
  GPU process. Whole-window traversal correctly rejected that foreign PID.
  Selecting the focused document now excludes this chrome subtree without
  admitting foreign content.
- A first diagnostic saw 270 nodes and six URL-less/empty Documents. Retained
  native `CUIAutomation8` queries in `ovgJjt` exposed the actual document URL
  after 900 ms. First-query emptiness was not universal URL unavailability.
- Chromium's iframe wrapper and actual child both use UIA Document. The
  wrapper has no ValuePattern; its actual child owns the URL. The reader
  recognizes only this validated structural wrapper and checks the child's
  domain normally. An empty or malformed present ValuePattern is rejected.
- A UIA intermediate host could retain an already-destroyed native HWND after
  navigation. Native HWND association is used only for nonsensitive cold
  initialization, not document authority. Live focused UIA ancestry and
  source revalidation govern body admission.

No PID allowlist, address-bar URL fallback, forced accessibility flag or
parent TextPattern aggregation was added. The same 256-node/depth-14 body and
700 ms cooperative budgets remain. The tests establish this Edge configuration
only; ordinary-user, browser-toolbar focus, other providers and private-mode
signals beyond the tested title heuristic remain separate coverage limits.
Temporary UIA diagnostics are not called by the harness. Raw synthetic
evidence is retained outside version control in the local lab notes.
