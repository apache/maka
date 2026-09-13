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

# Terminal-Bench 2.1 — Ollama Cloud DeepSeek V4 Flash 0731: Maka vs OpenCode

This report compares Maka and OpenCode on all 89 Terminal-Bench 2.1 tasks using Ollama Cloud's `deepseek-v4-flash:0731` model. It also combines the paired outcomes with the [previous DeepSeek V4 Flash run](./terminal-bench-2.1-deepseek-v4-flash-maka-vs-opencode.md) while treating the benchmark task, rather than each repeated observation, as the independent unit.

**Run id:** `deepseek-v4-flash-0731-maka-vs-opencode-tbench-2.1-full-v1`

**Local artifacts (git-excluded):** `~/.maka/eval/runs/deepseek-v4-flash-0731-maka-vs-opencode-tbench-2.1-full-v1/`

**Metric:** end-to-end pass@1 by the official task verifier

**Score status:** complete — 178/178 cells model-scored, with no accepted infrastructure failure

**Metering status:** one Maka timeout has a durable usage checkpoint but no exact final usage, so economic totals use the 88 fully metered pairs

**Per-task outcomes:** [`terminal-bench-2.1-ollama-deepseek-v4-flash-0731-maka-vs-opencode.csv`](./terminal-bench-2.1-ollama-deepseek-v4-flash-0731-maka-vs-opencode.csv)

## TL;DR

- **Maka passed 52/89 tasks (58.43%); OpenCode passed 43/89 (48.31%).** Maka led by 9 tasks, or 10.11 percentage points.
- This run alone has 18 Maka-only passes and 9 OpenCode-only passes. Its exact two-sided McNemar p-value is `0.1221`, so this repetition alone does not clear a 5% significance threshold.
- Across this run and the previous run, Maka passed 113/178 observations (63.48%) and OpenCode 92/178 (51.69%), a 21-observation or 11.80-point lead. A task-clustered exact sign-flip test gives **p = 0.00416**; the approximate task-clustered 95% interval for the mean lead is **+4.18 to +19.42 percentage points**.
- The account plan recorded $0 of incremental API cost for both arms. On the 88 fully metered pairs, Maka used 109.98M tokens and OpenCode 79.20M. Maka was more effective, while OpenCode used fewer measured tokens per cell and per successful task.
- Budget exhaustion did not disappear. It affected 25 Maka cells and 18 OpenCode cells in this run, compared with 15 and 24 respectively in the previous run. Provider speed alone therefore did not determine the deadline outcome.

## Current run

Budget-exhausted cells remain scored failures in the primary pass@1 denominator.

| Primary result | Maka | OpenCode | Maka − OpenCode |
| --- | ---: | ---: | ---: |
| End-to-end pass@1 | **52/89 (58.43%)** | **43/89 (48.31%)** | **+9 tasks (+10.11 pp)** |

The paired outcome table is:

| | OpenCode pass | OpenCode fail | Total |
| --- | ---: | ---: | ---: |
| Maka pass | 34 | 18 | 52 |
| Maka fail | 9 | 28 | 37 |
| Total | 43 | 46 | 89 |

For the exact McNemar test, the null assigns equal probability to either direction among the 27 discordant pairs. With 18 Maka-only and 9 OpenCode-only outcomes, the exact two-sided probability is `0.1220781`. The point estimate favors Maka, but this repetition by itself is not statistically conclusive at the conventional 5% threshold.

## Two-run evidence

The two runs used the same frozen 89-task suite, task fingerprint, system prompt, reasoning effort, deadline policy, concurrency, and OpenCode version. They used different provider/model identities: the first run used unversioned `deepseek-v4-flash` through DeepSeek, while this run used versioned `deepseek-v4-flash:0731` through Ollama Cloud. The combined result is evidence of repeatability across these two observed conditions, not a claim that the observations are identically distributed.

| Run | Maka | OpenCode | Maka − OpenCode | Exact paired p |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek V4 Flash | 61/89 (68.54%) | 49/89 (55.06%) | +12 (+13.48 pp) | 0.0118 |
| Ollama Cloud 0731 | 52/89 (58.43%) | 43/89 (48.31%) | +9 (+10.11 pp) | 0.1221 |
| Combined observations | **113/178 (63.48%)** | **92/178 (51.69%)** | **+21 (+11.80 pp)** | — |

The repeated observations for one task are correlated, so treating all 178 observations as independent pairs would overstate the effective sample size. The combined test instead swaps the Maka/OpenCode labels jointly for both runs within each of the 89 tasks. Its exact two-sided sign-flip probability is `0.00416393`. A task-clustered t interval around the 11.80-point mean difference is approximately `+4.18` to `+19.42` percentage points.

The direction is also stable at the task level:

| Outcome across the two runs | Tasks |
| --- | ---: |
| Maka-only pass in both runs | 5 |
| OpenCode-only pass in both runs | 0 |
| Maka-only pass in one run, tie in the other | 21 |
| OpenCode-only pass in one run, tie in the other | 10 |
| Direction reversed between runs | 3 |
| Neither run had a one-sided pass | 50 |

The two-run result supports the narrower claim that Maka maintained an advantage over OpenCode on this fixed suite under both tested DeepSeek V4 Flash conditions. It does not establish a universal harness ranking.

## Budget and non-budget diagnostics

The conditional denominator excludes the entire pair whenever either arm exhausted its budget. It is diagnostic, not an alternate headline score or an unlimited-time counterfactual.

| Diagnostic | Maka | OpenCode | Maka − OpenCode |
| --- | ---: | ---: | ---: |
| Non-budget Conditional Pass Rate | 47/58 (81.03%) | 40/58 (68.97%) | +12.07 pp |
| Budget Exhaustion Rate | 25/89 (28.09%) | 18/89 (20.22%) | +7.87 pp |

The previous run's corresponding conditional result was 52/61 versus 46/61, a 6-task lead; this run's lead is 7 tasks. The non-budget gap was therefore similar even though both absolute scores fell. Budget exhaustion shifted in the opposite direction across arms: Maka increased from 15 to 25 exhausted cells, while OpenCode decreased from 24 to 18.

This run also had 11 ordinary verification failures and one `max_tokens` failure for Maka, versus 28 ordinary verification failures for OpenCode. The lower OpenCode budget-exhaustion count did not translate into a higher pass rate because more of its completed candidates failed the official verifier.

## Economics

Ollama Cloud was used through an account plan whose frozen pricing identity records zero incremental USD cost. The result therefore supports a resource-footprint comparison, not a dollar cost-equivalence claim.

| Fully metered result (88 paired tasks) | Maka | OpenCode |
| --- | ---: | ---: |
| Input tokens | 103,865,919 | 75,546,644 |
| Output tokens | 6,117,410 | 3,651,993 |
| Total tokens | **109,983,329** | **79,198,637** |
| Tokens per metered cell | 1,249,811 | 899,985 |
| Tokens per successful task | 2,115,064 | 1,841,829 |
| Recorded incremental cost | $0 | $0 |

On this basis, Maka used 38.87% more measured tokens in aggregate and 14.83% more tokens per successful task. That is the tradeoff observed here: Maka produced 20.93% more passes (`52` versus `43`), while OpenCode had the lower token footprint.

The missing pair is `largest-eigenval`. Its Maka cell reached the 900-second deadline with a durable checkpoint of 217,648 input and 33,796 output tokens (251,444 total), but the outer timeout could have interrupted one additional in-flight request. The harness intentionally does not promote that checkpoint to exact final usage. Both arms failed this task, so the metering gap does not change either pass count or the primary result.

The previous run's API-equivalent cost per pass was $0.031718 for Maka and $0.031712 for OpenCode. Those dollar estimates should not be pooled with this account-plan run, and token totals should not be compared as if provider cache reporting were identical.

## Frozen setup

| Dimension | Value |
| --- | --- |
| Benchmark | Terminal-Bench 2.1, revision `d49e28f1e4ddd13d289e85a5f312a66750951932`; all 89 tasks |
| Task-tree fingerprint | `sha256:456826aa4c47ed309716c964c96d2a3acc998764ebc84f3e8449c807d74bd4e7` |
| Run fingerprint | `sha256:cf4e14cc32fa95bb2c39ce791ca450d01c9b25fdcc39ccc3bcf756638179ff94` |
| Model | `deepseek-v4-flash:0731` through Ollama Cloud on both arms |
| Reasoning effort | `max` on both arms |
| Repetitions | 1 |
| Metric | Paired pass@1 |
| Attempt policy | One accepted model attempt per arm/task; only pre-execution infrastructure-invalid admissions may be replaced |
| Deadline policy | Task-native agent timeout ×1; 900-second outer setup and teardown grace |
| Pair execution | Up to four task pairs concurrently; Maka and OpenCode start in parallel within a pair; at most eight cells concurrently |
| External system prompt | Empty on both arms |
| Maka arm | `maka_agent:MakaAgent`; continuation off; active and stale tool-result pruning enabled at a 2,048 estimated-token threshold; semantic compact off |
| OpenCode arm | `opencode_agent:MakaOpenCodeAgent` 1.17.18; pure mode; automatic permissions; `max` variant |
| Billing mode | Account plan; frozen incremental token prices are zero |

This is a same-model harness comparison, not a same-system/same-tool ablation. The two arms retain their native instructions, tools, context management, and execution loops. The observed difference belongs to the compared harness systems as a whole.

## Outcome and infrastructure audit

The controller WAL contains 188 admissions. The first 10 were the five pilot task pairs attempted while Docker was unavailable; they failed before model execution, were superseded once under the authorized infrastructure-retry policy, and do not enter pass@1. The accepted dataset contains exactly one model-scored outcome for every arm/task cell.

All 178 final Harbor trials contain an official verifier reward: 95 pass and 83 fail. Harbor recorded 21 `AgentTimeoutError` exceptions and no other final trial exception type; every timeout still reached the official verifier, and two timeout trials passed. The accepted controller projection contains 43 budget-exhausted failures because it also recognizes agent-runtime deadline evidence that does not surface as a Harbor exception.

There are 176 CTRF reports containing 608 verifier test cases: 424 passed and 184 failed, with no skipped, pending, `other`, or error-status test. The two trials without CTRF are Maka's `merge-diff-arc-agi-task` and `sqlite-with-gcov`. In both traces, the agent manually installed cached packages with `dpkg`, left the package database in a broken dependency state, and the unchanged verifier then failed to install its prerequisites. The corresponding OpenCode trial in the same task image reached the official tests and passed. These are agent-caused end-to-end failures, not external infrastructure failures.

Maka's `write-compressor` verifier had one setup-classified attempt followed automatically by a second verifier attempt with a determinate failure; its final reward is 0. Other apparent infrastructure strings in verifier logs were checked against the task and agent traces. They resolve to missing candidate services or files, candidate correctness failures, expected browser/test behavior, or warnings after successful downloads rather than external setup failures.

OpenCode's proxy telemetry contains 2,392 requests: 2,382 completed, 8 aborted at task deadlines, and 2 failed with HTTP 410. Both 410s occurred on the first request. `compile-compcert` then completed 29 later requests and passed; `rstan-to-pystan` completed 41 later requests before exhausting its task budget. Neither transient provider response invalidates the accepted outcome.

The generated harness report is `completed_with_gaps` and the background wrapper exits 1 only because the strict completion assertion requires exact final usage for every cell. This is a metering gap, not a score or infrastructure gap.

## Caveats

- Each run is one repetition over a fixed suite. The exact tests describe outcome asymmetry on these tasks and do not guarantee performance on another benchmark or task distribution.
- The task-clustered combined test preserves dependence between repeated outcomes for the same task, but the two provider/model conditions are not identical. The combined inference is about these two observed runs.
- Non-budget Conditional Pass Rate is selection-conditional. It cannot be interpreted as an unlimited-time result.
- Budget exhaustion does not isolate provider latency, generation length, tool time, or agent policy. Ollama Cloud's high generation throughput did not guarantee shorter end-to-end trajectories.
- Account-plan $0 is the recorded incremental price identity, not the subscription's total cost. The report does not assign a hypothetical API-equivalent price to this model.
- No external Oracle registry snapshot was configured. The official Terminal-Bench verifier remains the scoring authority.

## Integrity

SHA-256 hashes of the frozen local evidence and committed outcome projection:

| Source | SHA-256 |
| --- | --- |
| `harness-ab-manifest.json` | `f9360431fe82fd95cf61d23d8011cb790054f90335f4ce635b9c687aa22bb591` |
| `harness-ab-report.json` | `e4f48bf81d3300a3841d0c3a98e36462f679130d9d960f295605af357203ef57` |
| `controller/results.jsonl` | `f6a4b6ea073b3b558fac1f376f3383b7e057bf11fb23a7c8833612e05ceb087b` |
| `controller/results.jsonl.attempts.jsonl` | `ad6932e5f1eeef7fee9127aea051efe64ad243a008da816eac4305174604fb1c` |
| Committed outcome CSV | `7cf3abe68c23406228be7ff59b447d6842355ed8a0e92d54379ffba8ba79f2ba` |

## Artifact pointers

| Artifact | Local path |
| --- | --- |
| Generated report | `~/.maka/eval/runs/deepseek-v4-flash-0731-maka-vs-opencode-tbench-2.1-full-v1/harness-ab-report.{json,csv,md}` |
| Immutable manifest | `~/.maka/eval/runs/deepseek-v4-flash-0731-maka-vs-opencode-tbench-2.1-full-v1/harness-ab-manifest.json` |
| Controller WAL | `.../controller/results.jsonl` and `.../controller/results.jsonl.attempts.jsonl` |
