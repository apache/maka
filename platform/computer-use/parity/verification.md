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

The [case manifest](../../../scripts/computer-use-parity/cases.json) is an initial
ledger for comparing Maka with the original runtime used by LCU. It covers named
native, browser, audio, approval and lifecycle scenarios. It is not a complete
inventory of the original product and carries no passing runtime results.
The [static capability inventory](inventory.md) enumerates the original member
surface separately and keeps declarations without behavioral coverage visible.

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

## Capture records

Keep captures outside Git. Run each side against a fresh copy of the same
task-owned fixture, with its own desktop/profile, session bus, account and HOME.
Never copy agent credentials or operate the personal desktop. Preserve the
caller's sandbox and approval policy. macOS behavior requires macOS; cross
compilation or a Linux container cannot establish AX, Quartz or permission
behavior.

A runner writes one JSON record per side. There is no automatic live runner in
this scaffold. Existing desktop tests below do not emit this record format and
must not be presented as though they had completed a differential comparison.
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

Maka's [native tests](../tests/native.rs) cover WSL/Windows with an explicitly
selected disposable fixture window and matching Windows helper. The
[REPL/browser tests](../tests/repl_browser.rs) contain isolated Chrome and macOS
fixture tests. Their ignored-test requirements and platform guards are the
authority for execution prerequisites. A broad `cargo test` does not run those
ignored tests.

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
