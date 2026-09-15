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
from Node 24 in an unlocked Windows interactive session. Run it sequentially,
not alongside other desktop-driving tests. It does not test recorder events,
summary generation, or the frontend.

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

The ten cases require useful text before and after regular suppression.
A failed positive baseline makes suppression
coverage inconclusive and fails those cases. A provider error, worker timeout
or forced termination is never counted as successful suppression. Case failures
are recorded individually so later cases still run where setup remains usable.
Domain-blocking cases first require the same document (including the iframe
body and origin) to be readable with that domain allowed. A cross-process
iframe that native cannot safely capture therefore fails coverage rather than
appearing to prove that the blocklist works. Domain cases navigate back to the
allowed page for recovery.

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
- No `record` command runs. Every snapshot targets the exact directly spawned
  Edge PID and HWND after checking its executable, Node parent, profile
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
support if it was run from an elevated Windows session.

## Measured Failure Boundaries

On September 15, 2026, Windows 11 tests with Edge `151.0.4129.93` did not
establish useful browser capture. All nine semantic cases failed; only the
snapshot-only/no-segment-file case passed. Password, private-title, InPrivate,
blocked-domain and iframe protection were not validated: a `null` snapshot
without a working useful-body baseline is inconclusive.

A separate, synthetic-only diagnostic established the following boundaries:

- The first visible child of the test window was a Win32 `Pane` (control type
  `50033`) owned by another PID. In run `QpHdiT`, it was PID `10996`, parent
  browser PID `6244`. Its executable was the same `msedge.exe`, its command
  line contained `--type=gpu-process` and the run's isolated profile, and it was
  created about 153 ms after the browser. It was not identified as a renderer
  or an unrelated popup. Native stopped at this PID mismatch after two nodes,
  before observing any Document.
- The diagnostic's MTA `.NET System.Windows.Automation` raw-tree traversal
  completed with 270 nodes and no truncation. It found six visible Chrome
  Documents: five did not support ValuePattern; one supported it but returned
  an empty value. No valid Document URL was exposed through that inspection.
  This is evidence about that diagnostic interface, not proof about every
  Edge provider or native `CUIAutomation8` call.
- The 270-node diagnostic exceeds native's 256-node limit. Diagnostic traversal
  is not equivalent to native traversal, and native rejected this run earlier
  at the foreign PID, so node-budget rejection was not demonstrated.

Capture remains fail-closed. No cross-process capture authority or address-bar
URL fallback was added. Process lineage alone does not establish Document
origin, and removing the PID check would not resolve the missing URL evidence.
No forced-accessibility flag was used.

The historical InPrivate run also used a page named `inprivate`, which could
itself trigger title suppression. Run `L9XMw9` reran the neutral-title correction
on Windows in 17.7 seconds. All nine semantic cases still failed and the
snapshot-only case passed; InPrivate remained inconclusive because normal
browsing did not expose useful content. Neither run proves InPrivate protection.

Run `QB16Fs` reran the subsequent same-input and matched-title matrix on Windows
in 17.6 seconds. Both transition cases stopped at their same-document plaintext
baseline; neither reached its denied/recovery phases. The nine semantic cases
failed, the snapshot-only case passed, and both owned browser processes closed
normally. The stronger controls therefore preserve the same coverage gap.

Raw synthetic evidence is retained outside version control under
`docs/local/windows-history-browser-QpHdiT/`. Temporary UIA diagnostics are not
called by this harness; native stderr must be empty again. The diagnostic
scripts and captured artifacts are investigation records, not production
capture paths.
