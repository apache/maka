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

# Proposal: session-bound file-editing policy

**Status: draft for discussion; no strategy selected or runtime change implemented.**

This proposal follows [Astro-Han's architecture suggestion on PR #5533](https://github.com/apache/maka/pull/5533#issuecomment-5749491758).
We will compare the current per-model policy with session-bound alternatives through
controlled experiments before deciding which strategy is appropriate. The expected
simplifications below are hypotheses, not established results.

## Problem and current behavior

[PR #5533](https://github.com/apache/maka/pull/5533) introduced an Automatic / Enabled /
Disabled ApplyPatch setting per connection and model. Automatic consults model
metadata; an explicit setting overrides that default. The runtime chooses a
provider-compatible profile: OpenAI structured operations, Codex freeform V4A
patches, or portable function calls with `{ patch: string }`. When ApplyPatch is
enabled, it replaces Write/Edit in the model-facing editing surface.

Changing models or connections can therefore change both the editing tool family
and its protocol. History projection normalizes old ApplyPatch calls for the new
profile, or preserves execution facts when direct replay is unavailable. This
creates a compatibility matrix spanning model defaults, overrides, transport,
history, and Code Mode.

Relevant implementation references:

- [Model runtime resolution](../../packages/runtime/src/model-runtime.ts)
- [ApplyPatch profiles, routing, and replay conversion](../../packages/runtime/src/apply-patch-profile.ts)
- [History projection](../../packages/runtime/src/ai-sdk-message-projection.ts)
- [Session creation and Code Mode defaults](../../packages/runtime-host/src/server/session-catalog-coordinator.ts)

## Proposed direction

Treat the editing policy as a session-level tool contract, analogous to the
`toolMode` value stamped from `chatDefaults.codeModeEnabled` during session creation.
An illustrative field is `editingMode: 'write_edit' | 'apply_patch'`; its final name
and schema are deliberately undecided.

At creation, consult the initial model's capabilities to choose a default and
validate the combination with `toolMode`. Persist the resolved policy with the
session. Subsequent model changes would retain that policy, and resume and fork
would preserve it. If a creation-time user choice is needed, it belongs to this
same resolution step rather than an override that silently changes a running
session's contract.

Potential benefits to validate:

- Fewer editing-family transitions and less ApplyPatch-specific history conversion.
- A single creation-time policy decision instead of ongoing per-model precedence.
- An explicit compatibility table for direct tools and Code Mode before the first turn.
- A simpler settings experience if per-model editing controls become unnecessary.

Keeping ApplyPatch after switching to a less capable model may increase malformed
patches and recovery attempts. The suggestion that this is only a tolerable quality
degradation must be measured: a syntactically valid patch can still be incorrect,
and repeated recovery can exhaust the task budget.

## Separate editing policy from provider protocol

A fixed editing family does not by itself fix the wire schema. A session can keep
ApplyPatch enabled while switching between structured, freeform, and portable
profiles. Cross-profile replay conversion may still be required. In particular,
a multi-file portable patch cannot always be replayed as one structured operation.

We should not remove `normalizeApplyPatchReplayInput` or `applyPatchReplayFactText`
merely because a session stores `editingMode`. Their retirement depends on proving
that new sessions use a compatible representation throughout their supported
lifecycle. Existing mixed histories still require a compatibility path.

The experiments will compare these candidates:

| Candidate | Session policy | Provider protocol | Main question |
| --- | --- | --- | --- |
| A: current baseline | Resolved from the active connection/model and its override | Native when supported; otherwise portable | Does adapting to the model justify the policy and replay complexity? |
| B: fixed editing family | Write/Edit or ApplyPatch selected once at creation | Adapted to the current provider | Does policy stability help even when transport conversion remains? |
| C: fixed portable contract | Write/Edit or ApplyPatch selected once at creation | Portable ApplyPatch function schema throughout patch sessions | Does a common contract simplify replay without unacceptable quality or cost loss? |

For B, inspect native-to-native and native-to-portable transitions explicitly. For
C, validate ordinary function-calling support on each target provider and the Code
Mode projection. Unsupported combinations must be reported, not silently switched
to a different editing family. Pinning a provider-native schema and restricting
model switches is an additional tradeoff to discuss if neither fixed candidate is
viable; it is not an assumed compatibility solution.

## Experiment design

First prototype the policies behind an experimental switch and run deterministic
contract tests. Then run live-model evaluations; simulated responses cannot
establish patch quality or recovery behavior.

Use the same task corpus, starting repository state, model versions, prompts,
sampling settings, tool permissions, and time/token budgets across paired runs.
Record unavoidable protocol-specific prompt differences. Repeat each arm to
estimate variance and randomize run order. Choose sample size, acceptable quality
loss, and cost/latency limits before the comparison, using a pilot if necessary.

Cover both ordinary sessions and scripted model/connection switches:

- No switch, as a control for each model and editing policy.
- ApplyPatch-default to Write/Edit-default models and the reverse.
- All six directed transitions among structured, freeform, and portable profiles.
- Switches after single-file and multi-file edits, failed and partially applied
  patches, and a compacted history; continue after restart and fork as well.
- Direct tools and Code Mode, plus creation under Automatic / Enabled / Disabled
  settings for the baseline and explicit migration fixtures for the candidates.

Collect the following evidence per arm and scenario:

| Measure | Evidence |
| --- | --- |
| Task correctness | Independent task verifiers and final file diffs; report completion rate with uncertainty |
| Patch reliability | Invalid patches, tool errors, partial application, recovery attempts, and recovery success |
| Compatibility | Rejected provider requests, undeclared tool calls, incorrect or lost replay facts, and unsupported switches |
| Efficiency | Tokens, monetary cost, end-to-end latency, and budget exhaustion |
| Architectural cost | Remaining policy branches, replay cases, settings precedence, and migration obligations |

The existing [editing-contract evaluation](../eval/terminal-bench-2.1-deepseek-v4-flash-edit-contracts.md)
is useful background, but compares tool families in another harness on one model.
It does not establish the best session policy or cross-provider switch behavior;
its inconclusive quality comparison is not evidence of equivalence.

## Decision and compatibility requirements

Prefer a session-bound strategy only if it meets the predeclared quality and
efficiency limits, preserves replay correctness for supported switches, and offers
a demonstrated reduction in maintenance complexity. Compare B and C separately so
that policy stability and protocol standardization are not conflated. If evidence
is inconclusive, retain the baseline and expand the evaluation rather than declare
the strategies equivalent.

Before adopting a strategy, specify how sessions without the new field continue,
how existing mixed histories are replayed, and how saved model overrides affect
new sessions. No implementation should reinterpret historical edits or silently
discard explicit user settings. Keep compatibility conversion until the supported
legacy and cross-provider cases have been demonstrated to work without it.

Publish the measured results and resulting decision in this draft PR. This
document records the design alternatives and evaluation method; implementation,
migration, and any removal of settings or replay helpers follow the evidence.
