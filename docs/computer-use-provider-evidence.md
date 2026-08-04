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
restart runner remains available as `e2e:computer-use-process-restart-soak`,
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
