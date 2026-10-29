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

# Computer-use behavior comparison

The [case manifest](../../../scripts/computer-use-parity/cases.json) is a 33-case
ledger for comparing Maka with the original runtime used by LCU. It covers named
native, browser, audio, approval and lifecycle scenarios. The controlled
Linux/x64 results below match one explicitly selected case. They do
not complete the ledger or establish parity for the original product.
The [static capability inventory](inventory.md) enumerates the original member
surface separately and keeps declarations without behavioral coverage visible.
Full coverage of its 147 interface members, the 33 cases and the required
architectures across Linux, macOS and Windows remains incomplete. macOS
cross-target metadata checks do not establish native macOS behavior.

The [comparator](../../../scripts/computer-use-parity/compare.py) checks independently
recorded effects for one platform and architecture. It executes no application,
desktop input or network operation. All named cases for that platform must have
observations, matching outcomes and complete effect fields, with hash-verified
runtime evidence. Missing, unsupported, unverified or inventory-only records fail.
An **observed API refusal** is a valid result: record it with `status: "observed"`,
`outcome: "refused"` and the actual refusal and unchanged fixture state.

## Source evidence and platform differences

The initial REA record
`ev_b380ae28fdc1d77e7806772f549a4151478d842f4421f619c365cef85f44c209`
identifies selected shipped Sky JavaScript wrappers from ChatGPT `26.915.31945`,
runtime `0.0.16/20260915001755-492f19756c31`. It is static evidence; execution,
native helpers and unselected source relationships remain unknown. Those
identities describe the investigated artifact and do not select or reject an
installed app.

REA summary `ev_ba523369d54ccafb2c1f63e9a3cb4759ec17b1b5fe12a340f9c47d6aa651a5cd`
covers five selected modules from the same package's `@oai/cua` artifact, including
`@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js`.
Static inspection found different API shapes per platform. Its artifact SHA-256 is
`abc406496719f27a8b42e4f68afd423f4da43cbf10f42c2d57d8a905d8c8fb1c`;
466 files remain unselected. This is separate from the Sky evidence above.
The manifest records these as static expectations, separate from live results:

| Operation | Linux | macOS | Windows |
| --- | --- | --- | --- |
| `selectText` | Refused | Forwarded to native helper | Refused |
| `setValue` | Refused | Native path | Native path |
| Rich paste | Text only | Native formats | Text only |
| Scroll distance | Pixels | Pages | Point plus pixels |
| Indexed scroll | Needs live characterization | Native path | Refused |

Do not turn these differences into an invented universal superset. Probe the
actual selected runtime and record any change from the static expectation.
Original helper behavior, LCU adaptations and Maka behavior must remain distinct
in the evidence. In particular, LCU documents Unicode typing and Linux
window-input adaptations; a direct original-runtime probe and an LCU probe do not
necessarily have the same outcome. Give each reference a distinct subject name,
artifact inventory and recording.

### Linux native geometry: recorded scope

On 2026-10-26, original reference run `run-20261026T072511Z` and Maka candidate
run `run-20261026T084022Z` independently executed the same immutable fixture in
ordinary-user namespace containers with private HOME, X11, D-Bus and Openbox,
no host networking, and a 3840-by-2160 Xvfb display. Caller sandbox and approval
settings were preserved. The original subject was the unmodified Linux native
runtime with `@oai/cua` version `0.2.5`; the candidate was Maka `0.2.0`'s public
REPL with embedded Cua and `native-desktop` enabled. These runs used no personal
desktop or agent credentials.

Both receipts report exit `0`. The comparator reports
`matched_for_recorded_scope`, with no errors, for Linux/x64 and only
`native.capture-scale-and-window-move`. Its explicit one-case manifest has
SHA-256 `05ec8976a81e6bab97576a307b3ab0aa51391b437693422a1959c508b8b6b6ee`;
it does not replace or satisfy the full manifest. The four oracles remain exact:
`capture_dimensions`, `refusal`, `recipient` and `input_events`. Each assembled
record has 33 hash-verified evidence attachments from its own run.

The six stages cover input without capture, a stable large capture, movement
after capture, resizing after capture, a fresh capture after resizing, and AX
observation after resizing. All 14 click/scroll actions succeeded. The fixture
independently received all 28 press/release events at target-local `(37, 41)`,
with no sibling recipient or coordinate reinterpretation. The five actual JPEG
outputs are byte-identical between the two runs: four are 2400 by 1200, and the
fresh capture after resizing is 2600 by 1300. This establishes these controlled
opaque frames and these actions; it does not establish arbitrary-image,
gradient, MIME, boundary-input, or other-platform equivalence.

The candidate receipt records this actual build command from the repository
root:

```sh
cargo test --offline -p maka-computer-use --features native-desktop \
  --test repl_native_geometry --no-run
```

The consolidated test target is now `--test integration`; the command above
records the target name used for that historical receipt.

The tested ELF SHA-256 is
`e4cf2ffb0234f548aaac0d3fddc189be8b29bd6287074d001ca1b689ab1e861a`.
The retained source freeze identifies the inputs to that build; later source
edits require their own execution evidence. The private records are identified
here without publishing their contents or machine paths:

| Record | SHA-256 |
| --- | --- |
| Original capture, `run-20261026T072511Z` | `0d9f6a96f6a6ac099fe992514164dd5727325b1a8f88fbeeae895d7627c48c07` |
| Candidate capture, `run-20261026T084022Z` | `5a6495b243163b14db4fb395811598be68878c04a96264dfcff004a4d0d3522d` |
| Comparator report | `29e67cdfbf976fe93ccfb10e438c6f6d88a6cced492c415108c047acb5a8f6ed` |
| Five-JPEG byte comparison | `edd659ce5cd6629044d0360c3eeffefac6f0462a887556dfec1e516e19067098` |
| Candidate build source freeze | `8c82919f95f264c5821e830302bccc556c18d8aa782a85a90438dc0542597c9a` |

### Linux image encoding evidence and remaining probes

REA evidence
`ev_07bae53b3c17fd10ea70548a23c0caf2fb7b8fca3c1c47f2413a2948af3dd8ef`
covers the selected Sky screenshot JavaScript, and
`ev_f5b3eb6c48ef4c2b8e848bcd5d90b7bf0ac0b90a067ca309712f210a99bb23e6`
covers the native capture path. The original native helper SHA-256 is
`6d6971a8d09fa1c932587442d771c8beaf41b75e2a1e25e098b6112b46a691ad`.
The source-facts record has SHA-256
`c05cda5246bfa7868bb157547044c0e3ddf4f734d438d603cebb41e703a016c1`.
It records a source-backed inference of JPEG quality 80 from the encoder
formula and constructed quantization tables, corroborated by all 128 DQT bytes
of an original live JPEG. Quality 80 was uniquely matching in that analysis;
it was not recovered original configuration text. The observed JPEG and native
constructor use 1-by-1 sampling for all three components, without chroma
subsampling. Extracted code, assembly, tables and generated fragments stay
private.

### Linux coordinate boundaries and pointer API shape

Original run `run-20261026T075804Z` observed click/scroll refusal outside current
window bounds and native parsing refusal for fractional or out-of-i16
coordinates. Those refused calls produced no fixture input. Its capture SHA-256
is `12f822dea5a041e28135fa865da5c2e74b0ce9643a5ddef2fa03d23469b8c62a`.
Candidate run `run-20261026T094949Z` independently completed all 14 actions with
positive controls against the same immutable boundary fixture and exited `0`.
The strict comparator reports `matched_for_recorded_scope`, with no errors, for
Linux/x64 and only `native.capture-scale-and-window-move`, using the same explicit
one-case manifest identified above. All four exact oracles match, including
fractional, out-of-range, negative and window-edge refusals and their absence of
fixture input. This adds boundary coverage within that case; it does not satisfy
the full ledger.

The boundary candidate ELF SHA-256 is
`f505ada37370187b98b5adb44f42c239f72f1743a011e0e28c3fdb043af1bc64`.
Its capture SHA-256 is
`14664fa09f14de33f69ab0b23ae33e74512699a8e96f3e355f1d5448c6f71d59`,
and its comparator report SHA-256 is
`f89f5ca16f5af39a8791f71aaad73c1ca428d41192e0c39fc36aaa45be1a0a89`.
Later source edits require their own execution evidence.

Original run `run-20261026T085724Z` observed that the selected app object has no
`moveCursor` function; drag refused invalid bounds and numeric types, while a
valid drag delivered its target press/release. Its capture SHA-256 is
`6a0d2829ca0c9d7f3c3e09147d32c5bbe6a65a61011f038e3ab3d8a3730a01ee`.
The candidate pointer/drag probe `run-20261026T095321Z` exited `101` with an
incomplete capture and a `Promise was collected` REPL error. It is not a passing
comparison. Pointer/drag parity remains pending a fresh desktop run of the fixed
runtime; the original observations do not establish a candidate result.

### Kernel reset and native settlement

The selected original Linux runtime was also observed with a 300 ms JavaScript
budget and a native 5001-pixel scroll. It returned timeout at about 308 ms while
the fixture continued receiving the complete 50 wheel pairs. The next cell
accepted fresh JavaScript bindings immediately; previous bindings were gone.
A new native observation completed before the old input ended. Executable inode
and process observations identified a different native engine for that new cell.
An explicit kernel reset also returned before the earlier input completed.

The original Linux audio recorder continued to its duration limit after kernel
reset, while a new kernel's stop call reported no active recording. These are
separate observations from ordinary logical-turn completion. They do not prove
macOS or Windows reset behavior, or concurrent mutation behavior within one
kernel.

The Linux product-evaluation fixture now verifies early observation with an
independently owned native epoch: a 300 ms cell times out while its original
5001-pixel scroll continues, a fresh VM loses the old bindings, and fresh window
inventory and explicit reset complete before the scroll ends. The candidate
records exactly one durable dispatch and 50 balanced wheel pairs. Its inner
T2 precedes final Run termination even though the outer timeout T2 was earlier.
This exercises the real product evaluator, grants, journals and native SDK;
Host transport and permission UI remain separate tests.

This does not establish exact latency parity. The recorded candidate call took
about 518 ms overall, versus about 308 ms in the original native reference. The
measurement boundaries include different surrounding work; their contribution
has not been profiled.

Three Linux product audio fixtures have been added to cover recording across
reset, rejection of an old recording's Stop from a new VM, and replacement
isolation during natural completion. They also cover canonical Computer
permission revocation, final owner close, and equality between public Stop bytes
and the retained WAV. Their source distinguishes Start's completed startup T2
from background capture owned by the Session/Epoch after its Run ends.
At the Maka `e7f781fce6c` checkpoint (Cua `30defb12ca5a`), these three
fixtures had not been run. Retained execution receipts are still required for
the candidate under test, using generated output on an isolated null sink. Physical audio,
Host transport and permission UI remain separate verification scopes.

### Windows worker lifecycle: implementation and evidence limits

The WSL transport now keeps one logical owner for browser and cursor resources,
with separate native epochs and request identities. An old epoch's operation or
cleanup does not hold the parent Driver lock while awaiting its original reply.
Each epoch retains FIFO ordering, and closing it retains the original cleanup
result. The existing native operation cancellation token can cancel that exact
request; dropping a response observer, a REPL timeout, or epoch retirement alone
does not send a cancellation. A lost acknowledgement remains unknown or cleanup
unconfirmed and is never replayed.

Audio startup binds an observation to the exact capture before acknowledging
Start. Later captures cannot replace that observation, and capture/output
completion remains separate from native stop/join and temporary-file cleanup.
The completion event is sent after the successful Start reply. An epoch's turn
cleanup and the logical owner's shared browser cleanup have separate replies.

Static Windows evidence from REA
`ev_6fd85691ee36ba091fe8ef6b8b27296346bce5a06feb982802d3c4bc1966ff04`
and native subject SHA-256
`9493af2cebd3c11e2e38ce692f6ccd8e00f4320bdbbcf14f242d036a9736635f`
shows that the selected original helper stops and joins active audio at
`end_turn` and consumes its cleanup errors. Maka reuses its existing owned
audio-discard path on Windows and retains unconfirmed cleanup errors. This is
an explicit adapter difference. The new transport and cancellation behavior
requires its own actual Windows desktop validation; structural inspection and
hermetic transport tests cannot establish original Windows reset triggers or
native parity. macOS native reset verification also remains pending.

## Capture records

Keep captures outside Git. Run each side against a fresh copy of the same
task-owned fixture, with its own desktop/profile, session bus, account and HOME.
Never copy agent credentials or operate the personal desktop. Preserve the
caller's sandbox and approval policy. macOS behavior requires macOS; cross
compilation or a Linux container cannot establish AX, Quartz or permission
behavior.

A runner writes one JSON record per side. This comparison scaffold does not
automatically execute live tests. Capture execution and record assembly must be
explicit: the controlled results above used independently recorded captures per
side and an explicit one-case manifest. Other existing desktop tests below do
not emit this record format and must not be presented as though they had
completed a differential comparison.
Record the command actually executed, its working directory and exit code; do
not substitute an intended command. Do not log passwords, tokens or the complete
environment.

The record has these fields:

| Field | Meaning |
| --- | --- |
| `role` | `reference` or `candidate` |
| `run_id`, `recorded_at` | Distinct recording identity and UTC timestamp |
| `platform`, `architecture` | `linux` / `macos` / `windows`, and `x64` / `arm64` |
| `isolation`, `emulation` | `container`, `virtual-machine` or `dedicated-desktop-session`; emulator name or `none` |
| `command`, `cwd`, `suite_exit_code` | Executed argv array, working directory and actual exit code |
| `policy` | Strings `sandbox` and `approval` identifying the effective caller settings |
| `manifest_sha256`, `fixture_sha256` | SHA-256 of the exact manifest and shared fixture bundle |
| `subject` | Observed `name`, `version`, `runtime`, optional source revision, and `artifacts: [{name, sha256}]` |
| `cases` | Object keyed by every selected manifest case ID |

Each case contains `status`, `outcome`, `effects` and `evidence`:

```json
{
  "status": "unverified",
  "outcome": null,
  "effects": {},
  "evidence": []
}
```

This placeholder intentionally fails comparison. After an actual run, use
`status: "observed"`; `outcome` is `success`, `refused`, `partial` or
`outcome_unknown`. `effects` must contain exactly the case's named `oracles`.
Values are complete JSON values compared exactly, including Unicode, booleans,
counts, refusal categories and externally observed target state. Any normalization
must be explicit in the runner and must not discard a behavioral difference.
If timing, image compression or generated IDs vary, measure stable fixture
effects rather than deleting observations until records agree.

Evidence items have `{kind, path, sha256}`. Paths are relative to the record and
must remain inside its directory. Supported kinds are `fixture-state`,
`event-trace`, `screen-capture`, `audio-capture`, `authorization-trace` and
`repl-transcript`. Include independent fixture effects and the corresponding
runtime trace; successful return values alone do not prove input delivery,
clipboard restoration, navigation or cleanup. Reference and candidate may not
reuse the same evidence file. Hash identities do not establish that supplied
metadata is true: reviewers still need the runner and raw evidence.

Do not include OpenAI binaries, extracted code, instructions or generated source
fragments in Git, releases or public evidence exports. A record may retain
identity hashes and source locations. Keep any private REA export local.

## Run the comparison

From the Maka repository root:

```sh
python3 scripts/computer-use-parity/compare.py \
  /absolute/private-captures/reference/run.json \
  /absolute/private-captures/candidate/run.json \
  --report /absolute/private-captures/comparison.json
```

Exit `0` means `matched_for_recorded_scope`; exit `1` means effects differ or
required evidence is unverified; exit `2` means malformed or unreadable inputs.
The report names its exact manifest, platform, architecture and case IDs.
Output reports must be new files unless `--overwrite` is explicitly supplied.
Even with that flag, inputs and attached evidence cannot be replaced.
A platform-specific pass establishes only that scope. Full three-platform
parity additionally requires all required architectures, an exhaustive capability
inventory and their independently reviewed native evidence.

The comparator's synthetic checks are:

```sh
python3 -m unittest discover -s scripts/computer-use-parity -p 'test_*.py'
```

These checks prove comparison behavior only. They do not launch a desktop.

## Existing live test entry points

Maka's [native tests](../tests/integration/native.rs) cover WSL/Windows with an explicitly
selected disposable fixture window and matching Windows helper. The
[REPL/browser tests](../tests/integration/repl_browser/mod.rs) contain isolated Chrome and macOS
fixture tests. Their ignored-test requirements and platform guards are the
authority for execution prerequisites. A broad `cargo test` does not run those
ignored tests.

The Linux product-epoch fixture is
[`live_tests.rs`](../../../plugins/workspace/workspace-computer/native/src/live_tests.rs).
Build the `maka-computer-native` lib tests with dependency feature
`maka-computer-use/native-desktop`, then run the ignored
`live_tests::linux_product_timeout_retires_vm_but_run_waits_for_exact_native_t2`
inside the disposable X11/D-Bus desktop. It requires
`MAKA_COMPUTER_LIVE_FIXTURE_BIN` pointing to the separately built computer-use `integration`
fixture executable and `MAKA_COMPUTER_LIVE_ARTIFACT_DIR` pointing to its own
writable capture directory. Unix sockets must remain on a Linux filesystem;
`MAKA_COMPUTER_LIVE_SOCKET_DIR` can select that task-owned location. The fixture
records raw input, timings and canonical ledgers and never selects a personal
desktop.

The same lib-test executable contains three ignored `live_tests::audio::`
fixtures. Run them serially through Cua's existing private Pulse runner with
`--ignored --nocapture --test-threads=1`, an explicit
`MAKA_COMPUTER_LIVE_ARTIFACT_DIR`, and dependency feature
`maka-computer-use/native-desktop`. The recording fixture refuses a normal audio
server and requires that runner's output-only null sink. It needs no host display
or host audio socket. Keep the generated tone, recorder, HOME and session bus in
the disposable container.

LCU's `tests/run.sh linux/amd64 /absolute/verified-package.deb` runs its offline
installation and real Linux desktop gates inside disposable containers; its
`tests/differential_baseline.py` starts the untouched official REPL for a
reference-side probe. Those are external source-repository entry points, not new
Maka runner implementations. Preserve their source SHA and exact tested inputs.
The LCU gate verifies its own adapter and baseline, not Maka's new behavior.

For stale indexed scroll, keep the original token valid in the driver's cache:
observe the container, remove it and insert a replacement at its ordinal without
another observation, then scroll using the old token. Record the refusal and
independent replacement/sibling offsets. Merely refreshing before dispatch tests
a different state transition and can hide retargeting.

The ignored Linux GTK test
`linux_screenshot_only_keeps_exact_observed_elements_until_replacement` exercises
screenshot-only retention, stale-token refusal and a newly observed replacement
at the same ordinal. It keeps the default AX budget and checks the fixture's
visible state and a positive wheel effect. Run it with `HARNESS_GTK3_EXE` pointing
to the task-owned Cua GTK3 fixture on the disposable X11/AT-SPI desktop. This
integration test does not emit the differential record format above.
