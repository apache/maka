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

# Computer Use Provider Evidence

This layer defines the evidence contract for real-model Computer Use runs. It
does not claim that any provider has completed a real run.

## Scenario Contract

The scenario library defines:

- an owned Electron fixture;
- the exact user prompt and expected state;
- forbidden effects;
- allowed actions and per-action budgets;
- required execution capabilities;
- deterministic state evaluation.

The fixture helper imports Electron only. It does not import Maka Runtime,
provider transports, or execution backends.

## Report Contract

Reports separate three evidence classes:

- `real-runtime`: a live provider model used the production Maka runtime;
- `fault-injection`: a live provider and Runtime exercised a named injected
  failure, but the run cannot qualify as real host evidence;
- `hermetic-protocol`: a fake transport proved protocol behavior;
- `static-contract`: source or schema checks only.

Only `real-runtime` can satisfy a provider matrix cell marked `real`.
Policy-bypassed runs remain visibly labeled and cannot become an unqualified
pass.

Real reports also fail closed unless producer, transport, policy mode, model,
fixture PID/window ownership, latest-observation lineage, action budgets, and
dispatch provenance are explicit. Expected failures must be authorized by the
scenario; a report cannot authorize itself.

The sanitizer preserves action types, timing, result codes, aggregate state,
and allowlisted trace fields. It removes coordinates, typed text, raw UI
content, credentials, full URLs, and provider payloads.

## Consolidation Findings

Review found that the AppKit producer emitted `traces` while qualification read
`driverTraces`, and the Desktop launcher derived its fixture window allowlist
from the actions being judged. The first mismatch rejected valid AX evidence;
the second allowed circular ownership proof.

Both producers now emit one canonical schema. Desktop fixture identity is
collected independently from the launcher-owned PID and executor window
inventory before model execution. Qualification waits for matching dispatch
traces and requires each target to belong to that independent identity.

Qualification also keeps three fail-closed invariants:

- restart recovery authorizes only the scenario-declared stale
  `set_value / target_missing` result and budgets the required fresh retry;
- disallowed and over-budget model attempts are recorded as canonical failed
  action evidence before the harness rejects them;
- the Desktop launcher and provider matrix call the same real-report validator,
  so a launcher cannot exit successfully for a matrix-invalid report.

The old direct real-machine qualification runner was removed. The five-round
restart runner remains available as `npm run computer-use -- restart-soak`,
but is regression-only and cannot satisfy a provider matrix cell. There is one
qualification path rather than parallel evidence standards.

## Next Layer

A provider launcher must:

1. pin a scenario from this library;
2. run against the owned fixture and production Computer Use backend;
3. enforce the scenario action budget before dispatch;
4. emit a sanitized `real-runtime` report;
5. let the provider matrix validate fixture state and forbidden effects.

## First Real Run

The first qualifying run completed with:

- provider: OpenAI;
- model: `gpt-5.4`;
- evidence class: `real-runtime`;
- tool exposure: direct E2E, with only the production `maka_computer` tool;
- action: one app-scoped `observe`;
- tool latency: 1117 ms;
- total run latency: 7502 ms;
- terminal status: `complete / end_turn`;
- fixture oracle: verification code matched and interaction count remained zero.

The direct E2E tool exposure is deliberate. The default deferred `load_tools`
path remains a separate product contract; the launcher narrows provider
variables while still exercising the production tool implementation, permission
engine, Runtime, Desktop host, and executor backend.

During this run, OpenAI Responses tool continuation exposed a product bug:
server-side storage generated an `item_reference` in the second request without
a `previous_response_id`, so custom Responses endpoints rejected the tool
result. OpenAI provider options now use `store:false`, matching the existing
Codex subscription boundary and keeping function calls/results inline.

The next run should perform one AX semantic mutation after executor hardening is
merged.

That L1 run has now completed:

- scenario: `l1-single-click`;
- provider/model: OpenAI `gpt-5.4`;
- actions: two observations and one `click_element`;
- no coordinate or compatibility input action was allowed;
- semantic click latency: 1445 ms;
- total run latency: 26023 ms;
- fixture oracle: primary click count 1, danger click count 0, over-click count
  0;
- terminal status: `complete / end_turn`;
- result: pass.

The run initially failed closed when the user's foreground ChatGPT window
occluded the synthetic target. The fixture host now settles and raises its
layer-0 window with `showInactive()` and `moveTop()` before declaring readiness,
without focusing it or using an always-on-top overlay layer.

## Native WebContent Qualification

The executor pinned by `apps/desktop/bundled-tools.json` now carries source
commit `4a9787d2c7f2fbc6a29b33d691916c6b84543661`, including
`maka-agent/maka-cu#2`, the window-transition follow-up in #3, and the direct
WebContent frame-reflow fix in #4.

The shared synthetic CUA Lab was run ten consecutive times before integration:

- observation exposed one OOP button after unique mirror removal;
- slider requested/readback/business oracle: `42 / 42 / 42`;
- scroll path: semantic `ax_action`, oracle offset `76`;
- OOP click path: `skylight_pid`;
- DOM `MouseEvent.isTrusted`: `true`;
- host local mouse events: one down and one up;
- stale wrong-target count: `0`;
- target application never became frontmost.

A separate live retained-element probe exercised the three refetch outcomes:

- unique replacement: action completed once, wrong target `0`;
- missing replacement: `element_released`, no side effect;
- ambiguous replacement: `element_changed`, no side effect.

After #4, the exact binary pinned by `apps/desktop/bundled-tools.json`
(`e457a3143544ba8385c489e5259f206d9450feb1c692eb562413b41b9f38de21`)
completed a source-bound five-run Web matrix:

- the probe rebuilt clean source commit `4a9787d2c7f2fbc6a29b33d691916c6b84543661`
  and required the pinned binary bytes to match that build;
- primary AX click oracle was 1 in every run;
- every OOP click used `skylight_pid`, produced `MouseEvent.isTrusted=true`,
  and delivered exactly one host-local mouse down/up pair;
- slider was 42 and scroll offset was 76 in every run;
- unique refetch clicked the intended stale target once, while missing refetch
  had no target or decoy effect;
- all 30 foreground-sentinel spans recorded zero target-frontmost samples, with
  at least 92 samples per span and a maximum 80 ms sample gap.

The deterministic source suite separately forces direct WebContent frame-only
reflow through unique, missing, and ambiguous refetch outcomes, preserves a
distinct renderer process generation, and confirms that native AX frame changes
remain fail closed.

This is native executor evidence, not a provider-model qualification cell. A
future `real-runtime` web scenario must still pass the report contract above.

The same source commit adds `doctor --json`. A release-binary smoke on the
locked-screen state correctly reported permissions granted, all required native
SPIs available, an ad-hoc non-hardened signature, and
`metadataObservation / screenshotObservation / trustedWebContentClick = false`.

Modal and secondary-window routing now have deterministic and live native
functional evidence. Five consecutive CUA Lab runs against the exact pinned
binary completed:

- modal open, app observation routed to the sheet, close, and return to main;
- secondary open, app routing to the frontmost secondary window, exact-window
  button click, semantic scroll, close, and return to main;
- all 30 dispatch paths were `ax_action`;
- button count was 1 and scroll offset reached 140;
- the five per-run records are retained in one aggregate fixture.

The high-frequency foreground sentinel does not pass: across ten modal/secondary
sampling spans it recorded 1,738 target-frontmost samples, with at least 189
samples per span and a maximum 96 ms sample gap. The stage-level before/after
reads had hidden this transient focus theft. Modal/multi-window routing is
therefore functionally qualified but does not yet satisfy the background-focus
contract.

The source includes bounded handling for two measured AppKit races: a newly
listed CGWindow may publish its AXWindow later, and a press may return
`cannotComplete` while creating or closing a window. This five-run fixture did
not exercise the topology-recovery verification arm
(`topologyRecoveryEvidenceCount: 0`), so that behavior remains implementation
and unit-test evidence rather than a live claim.

This is native executor qualification, not a provider-model matrix cell.

The same pin now carries stable AX observation revisions:

- the first tree receives depth-first stable ids;
- matched siblings preserve ids across fresh snapshot tokens;
- new ids begin above the previous maximum;
- post-action observations can render no-change, ordered insert/update changes,
  compressed removed-id ranges, or a full-tree fallback;
- explicit observe continues to render the complete tree.

This is hermetic protocol/static contract evidence, not a provider-model
qualification cell. The native source suite passed 326 tests with 26 explicit
live-test skips, and the host Computer Use suite passed 124 tests. The
modal/secondary evidence above was run after unlock.
