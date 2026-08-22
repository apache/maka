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

# Terminal-Bench 2.1 — DeepSeek V4 Flash: Maka vs OpenCode

This report compares Maka and OpenCode as two agent harnesses around the same DeepSeek V4 Flash model on all 89 Terminal-Bench 2.1 tasks. It records the frozen experiment, accepted outcomes, paired inference, outcome-normalized economics, and the recovery decisions required to produce a fully scored dataset.

**Run id:** `deepseek-v4-flash-maka-vs-opencode-tbench-2.1-full-v7`

**Local artifacts (git-excluded):** `~/.maka/eval/runs/deepseek-v4-flash-maka-vs-opencode-tbench-2.1-full-v7/`

**Metric:** end-to-end pass@1 by the official task verifier

**Status:** `completed` — 178/178 cells model-scored, no unscored infrastructure cell, and no missing final usage

**Per-task outcomes:** [`terminal-bench-2.1-deepseek-v4-flash-maka-vs-opencode.csv`](./terminal-bench-2.1-deepseek-v4-flash-maka-vs-opencode.csv)

## TL;DR

- **Maka passed 61/89 tasks (68.54%); OpenCode passed 49/89 (55.06%).** Maka led by 12 tasks, or 13.48 percentage points.
- The paired outcomes were 16 Maka-only passes, 4 OpenCode-only passes, and 69 ties. An exact two-sided McNemar test on the 20 discordant pairs gives **p = 0.0118**. This is evidence about the fixed 89-task Terminal-Bench 2.1 suite, not proof of a universal advantage on other task distributions.
- The observed accepted-dataset API-equivalent cost per pass was effectively the same: **$0.03172 for Maka and $0.03171 for OpenCode**. No cost-equivalence test was performed, so this is a descriptive point estimate rather than a statistical equivalence claim.
- Two diagnostics accompany, but do not replace, end-to-end pass@1. On the shared 61-pair subset obtained by excluding any pair where either arm exhausted its budget, Maka passed 52/61 (85.25%) and OpenCode 46/61 (75.41%). Budget exhaustion affected 15/89 Maka cells (16.85%) and 24/89 OpenCode cells (26.97%). These observations decompose the final gap; this run does not identify their causal mechanisms.

## Results

End-to-end pass@1 is the primary result. Budget-exhausted cells remain scored failures in its denominator.

| Primary result | Maka | OpenCode | Maka − OpenCode |
| --- | ---: | ---: | ---: |
| End-to-end pass@1 | **61/89 (68.54%)** | **49/89 (55.06%)** | **+12 tasks (+13.48 pp)** |

The paired outcome table is:

| | OpenCode pass | OpenCode fail | Total |
| --- | ---: | ---: | ---: |
| Maka pass | 45 | 16 | 61 |
| Maka fail | 4 | 24 | 28 |
| Total | 49 | 40 | 89 |

For the exact McNemar test, the null assigns equal probability to either direction among discordant pairs. With 16 Maka-only and 4 OpenCode-only outcomes, the two-sided exact binomial probability is `2 × P[Binomial(20, 0.5) ≤ 4] = 0.0118179`. The test treats the 89 benchmark tasks as the paired units. Because this was one frozen run over one fixed suite, the p-value should not be read as a guarantee for other benchmarks, task distributions, provider conditions, or repetitions.

## Diagnostic decomposition

The following metrics diagnose where the observed end-to-end gap appears; neither is an alternate headline score.

| Diagnostic | Maka | OpenCode | Maka − OpenCode |
| --- | ---: | ---: | ---: |
| Non-budget Conditional Pass Rate | 52/61 (85.25%) | 46/61 (75.41%) | +9.84 pp |
| Budget Exhaustion Rate | 15/89 (16.85%) | 24/89 (26.97%) | −10.11 pp |

The conditional denominator excludes the entire pair whenever either arm is `budget_exhausted`, leaving the same 61 tasks for both arms. It is not an “unlimited-time pass rate”: the remaining tasks still ran under their original budgets, and the excluded set is not random. The simultaneous conditional-pass and budget-exhaustion differences show that both dimensions accompany the end-to-end result. They do not by themselves isolate model solution quality, inference speed, or agent turnover efficiency as causes.

## Outcome-normalized economics

Cost per pass is the primary economic denominator because it normalizes recorded usage by successful benchmark outcomes. It includes spending on all accepted scored failures, but excludes superseded infrastructure-invalid admissions from the accepted dataset.

| Economic result | Maka | OpenCode |
| --- | ---: | ---: |
| Accepted-dataset API-equivalent cost per pass | **$0.031718** | **$0.031712** |
| Passed tasks | 61 | 49 |

The observed difference is less than $0.000007 per pass, or 0.02%. At the precision supported by this single run, the two point estimates are effectively the same. This is not a statistical cost-equivalence result: the experiment has one repetition and no uncertainty model for cost per pass.

For completeness, the resource footprint behind that outcome-normalized result is:

| Resource diagnostic | Maka | OpenCode |
| --- | ---: | ---: |
| Accepted scored-cell cost | $1.934813 | $1.553888 |
| Cost per scored cell | $0.021739 | $0.017459 |
| Total tokens | 173,281,686 | 115,523,680 |
| Cached input tokens | 166,618,240 | 110,226,048 |
| Uncached input tokens | 3,315,719 | 2,083,315 |
| Output tokens | 3,347,727 | 3,214,317 |
| Cache-hit share of input | 98.05% | 98.15% |

OpenCode had a lower per-cell footprint, but it also produced fewer passes. The lower aggregate spend therefore does not become an observed cost-per-success advantage. The report keeps resource footprint and outcome-normalized economics separate rather than combining them into a composite score.

Costs are cache-aware API-equivalent estimates from the pricing identity frozen in the manifest: $0.145 per million uncached input tokens, $0.0029 per million cache-hit input tokens, and $0.29 per million output tokens. They are not a billing invoice.

## Frozen setup

| Dimension | Value |
| --- | --- |
| Benchmark | Terminal-Bench 2.1, revision `d49e28f1e4ddd13d289e85a5f312a66750951932`; all 89 tasks |
| Task-tree fingerprint | `sha256:456826aa4c47ed309716c964c96d2a3acc998764ebc84f3e8449c807d74bd4e7` |
| Run fingerprint | `sha256:d18bc4c5ab0dd15161f48838ab0fa4a7a9ba2654f6008afe36d3d398fdf5fff3` |
| Model | `deepseek-v4-flash` through the DeepSeek provider on both arms |
| Reasoning effort | `max` on both arms |
| Repetitions | 1 |
| Metric | Paired pass@1 |
| Attempt policy | One accepted model attempt per arm/task; only infrastructure-invalid admissions may be replaced |
| Deadline policy | Task-native agent timeout ×1; 900-second outer setup and teardown grace |
| Pair execution | Up to four task pairs concurrently; Maka and OpenCode start in parallel within a pair; at most eight cells concurrently |
| External system prompt | Empty on both arms |
| Maka arm | `maka_agent:MakaAgent`; continuation off; active and stale tool-result pruning enabled at a 2,048 estimated-token threshold; semantic compact off |
| OpenCode arm | `opencode_agent:MakaOpenCodeAgent` 1.17.18; pure mode; automatic permissions; `max` variant |
| Billing mode | Metered, using the frozen DeepSeek V4 Flash pricing identity above |

This is a same-model harness comparison, not an isolated model evaluation and not a same-system/same-tool ablation. The two arms retain their native agent instructions, tool behavior, context management, and execution loops. The observed difference is therefore attributable to the compared harness systems as a whole; this run does not rank individual harness differences as causes.

## Outcome accounting and recovery

The accepted dataset selects the latest authorized terminal outcome for each arm/task cell under the immutable run fingerprint. The attempts WAL contains **183 Agent admissions**: 178 initial admissions plus five single infrastructure retries. Those retries covered four Maka cells (`winning-avg-corewars`, `polyglot-rust-c`, `path-tracing`, and `qemu-startup`) and one OpenCode cell (`polyglot-rust-c`). No cell received a third Agent admission.

The adjudication ledger contains 25 taxonomy-only corrections that did not change pass/fail: 24 OpenCode cells with authoritative Harbor `AgentTimeoutError` evidence were normalized from `verification_failed` to scored `budget_exhausted`, and OpenCode `rstan-to-pystan` was normalized from harness infrastructure to a scored candidate runtime/resource failure after substantial execution and an official verifier result. Two pre-execution Maka failures were reclassified as unscored infrastructure before receiving their one allowed replacement admission.

The final OpenCode `polyglot-rust-c` admission completed all five provider requests, recorded complete usage, wrote and locally compiled the requested candidate, and then encountered verifier setup infrastructure failure twice because the task container could not reach the Ubuntu archive. The container was deleted, but the single-file candidate was durably and completely represented in the second admission's trajectory. The candidate was reconstructed byte-for-byte (`sha256:dfa4c4cd3b41744e6fd4f971ca544075cc305d625bcd4b515b8ba559438c2cd3`) and replayed only through the unchanged official verifier in the pinned `linux/amd64` task image with the original 1 CPU / 2 GiB limits. The official test passed and returned reward 1. This recovery changed the cell from unscored infrastructure to pass without invoking the model again; the Agent admission count remained two.

The recovery layer is append-only: superseded events remain in the WAL, adjudications identify their source event, and the final verifier-only replay has a separate local evidence manifest. The committed CSV contains only the selected final pass/fail and failure-class projections; prompts, trajectories, provider payloads, raw logs, and local capabilities are not published.

## Caveats

- This is one repetition over a fixed 89-task suite. The exact paired p-value describes asymmetry on this suite and does not establish universal superiority.
- The arms share the model, provider, task order, instructions, verifier, deadline policy, and infrastructure-retry policy, but they intentionally retain native harness behavior. This is not a single-variable component ablation.
- Non-budget Conditional Pass Rate is selection-conditional and diagnostic. It cannot be interpreted as an unlimited-time counterfactual.
- Budget exhaustion records that a valid candidate opportunity reached the benchmark deadline and then received an official verifier result. It does not by itself distinguish provider latency, model generation length, tool time, or agent policy.
- Cost per pass is an accepted-dataset point estimate from recorded usage and frozen API-equivalent prices. It includes scored failures but excludes superseded infrastructure-invalid admissions, whose complete metering is not always available. “Effectively the same” describes the observed values, not a formal equivalence interval or total experiment-operations cost.
- No external Oracle registry snapshot was configured. Oracle annotations are missing for all 89 tasks; the official Terminal-Bench verifier remains the scoring authority.
- Five infrastructure-invalid Agent admissions were replaced under the same bounded policy, and one completed candidate required verifier-only replay. These recoveries are disclosed above because omitting them would make the final coverage and score non-reconstructible.

## Integrity

SHA-256 hashes of the frozen local evidence and committed outcome projection:

| Source | SHA-256 |
| --- | --- |
| `harness-ab-manifest.json` | `c364730ac5e3db4ff8a6cf0b22a50b4e4f953ee05d090dc69415cb9012376e9c` |
| `harness-ab-report.json` | `bd616091c18bed6ad8d4bfe7534c7f4d6a6861c01b1c6f383d408b39673f922b` |
| `controller/results.jsonl` | `19764b90cbebddeb05c20d58be8760bfdabac1bf99e1c15a0528c0f934cd9835` |
| `controller/results.jsonl.attempts.jsonl` | `4878ca5b612d20d87a28066456ddcdc32a5c0bb105940cb0e6ef270a2355c7ab` |
| `controller/adjudications.jsonl` | `7253f3cf043cf5079428b704baf3ee30b8c259a4dc806704cb7016914a4cd667` |
| Verifier-only replay `evidence.json` | `93b786d4305452bf1f1ef15f5474f5902bc979255e89c61f5669581caab5178b` |
| Committed outcome CSV | `a1f52e1fbb4463ed1f9a6d591dd50aa8eaff67dbb825d05a36213d0d3a25e766` |

## Artifact pointers

| Artifact | Local path |
| --- | --- |
| Generated report | `~/.maka/eval/runs/deepseek-v4-flash-maka-vs-opencode-tbench-2.1-full-v7/harness-ab-report.{json,csv,md}` |
| Immutable manifest | `~/.maka/eval/runs/deepseek-v4-flash-maka-vs-opencode-tbench-2.1-full-v7/harness-ab-manifest.json` |
| Controller WAL | `.../controller/results.jsonl` and `.../controller/results.jsonl.attempts.jsonl` |
| Adjudication ledger | `.../controller/adjudications.jsonl` |
| Verifier replay evidence | `.../controller/verifier-replays/ab-opencode-r0-polyglot-rust-c-attempt-2/evidence.json` |

The experiment was tracked in [issue #1680](https://github.com/maka-agent/maka-agent/issues/1680).
