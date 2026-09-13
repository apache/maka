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

# Terminal-Bench 2.1 — DeepSeek V4 Flash nine-harness comparison

This report records the final selected outcomes for nine coding-agent harnesses around the same
DeepSeek V4 Flash model on all 89 Terminal-Bench 2.1 tasks. It extends the earlier four-arm report
in [#2208](https://github.com/maka-agent/maka-agent/pull/2208) with OpenCode, Kimi Code, ZCode, Pi,
and DeepSeek Harness (DSH).

**Benchmark:** Terminal-Bench 2.1, revision
`d49e28f1e4ddd13d289e85a5f312a66750951932`

**Model:** `deepseek-v4-flash`

**Reasoning effort:** `max`

**Metric:** end-to-end pass@1 by the official task verifier

**Per-task outcomes:**
[`terminal-bench-2.1-deepseek-v4-flash-nine-arm.csv`](./terminal-bench-2.1-deepseek-v4-flash-nine-arm.csv)

## TL;DR

- **Codex leads at 73/89 (82.0%)**, followed by Maka at 69/89 (77.5%), Pi at 66/89
  (74.2%), and DSH at 65/89 (73.0%).
- All nine harnesses pass the same 28 tasks. Five tasks fail on every harness:
  `extract-moves-from-video`, `filter-js-from-html`, `gcode-to-text`,
  `make-doom-for-mips`, and `torch-pipeline-parallelism`.
- Pi records the lowest observed cost per pass at $0.019739. DSH and Maka are nearly tied on this
  measure at $0.026230 and $0.026307.
- The original eight arms ran as one cohort. DSH ran later under the same benchmark, model,
  reasoning, tool-egress, permission, verifier, and task-native timeout contracts, but not in the
  same simultaneous cohort. The nine-way ranking is therefore descriptive rather than a paired
  causal comparison.

## Leaderboard

The reporting projection treats the token, cache, and cost values recorded by the selected attempts
as authoritative and does not extrapolate unobserved provider usage.

| Rank | Harness | Passed | Pass@1 | Tokens | Average/task | Cache rate | Cost |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Codex | 73/89 | **82.0%** | 259.62M | 2.92M | 98.6% | $2.105 |
| 2 | Maka | 69/89 | **77.5%** | 185.71M | 2.09M | 98.8% | $1.815 |
| 3 | Pi | 66/89 | **74.2%** | 131.40M | 1.48M | 98.5% | $1.303 |
| 4 | DSH | 65/89 | **73.0%** | 182.84M | 2.05M | 98.6% | $1.705 |
| 5 | ZCode | 63/89 | **70.8%** | 223.46M | 2.51M | 98.9% | $2.287 |
| 6 | Reasonix | 60/89 | **67.4%** | 216.17M | 2.43M | 99.0% | $1.935 |
| 7 | OpenCode | 58/89 | **65.2%** | 166.44M | 1.87M | 98.6% | $1.745 |
| 8 | Kimi Code | 53/89 | **59.6%** | 193.75M | 2.18M | 98.2% | $2.162 |
| 9 | Claude Code | 49/89 | **55.1%** | 247.60M | 2.78M | 98.9% | $2.633 |

The 26.9-point spread between Codex and Claude Code is 24 tasks. Every task is worth approximately
1.12 percentage points on this fixed suite.

## Outcome agreement

| Agreement class | Tasks |
| --- | ---: |
| All nine pass | 28 |
| All nine fail | 5 |
| Mixed outcome | 56 |

The per-task CSV is the authoritative projection for these counts. It contains exactly 89 unique
task ids and reproduces every harness total in the leaderboard.

## Outcome-normalized economics

Cost per pass includes the recorded cost of both successful and failed selected cells.

| Harness | Recorded cost | Passed | Cost/pass |
| --- | ---: | ---: | ---: |
| Pi | $1.303 | 66 | **$0.019739** |
| DSH | $1.705 | 65 | **$0.026230** |
| Maka | $1.815 | 69 | **$0.026307** |
| Codex | $2.105 | 73 | **$0.028832** |
| OpenCode | $1.745 | 58 | **$0.030084** |
| Reasonix | $1.935 | 60 | **$0.032252** |
| ZCode | $2.287 | 63 | **$0.036303** |
| Kimi Code | $2.162 | 53 | **$0.040798** |
| Claude Code | $2.633 | 49 | **$0.053741** |

These are descriptive point estimates from one selected attempt per cell. They are not billing
invoices or statistical cost-equivalence claims.

## Frozen execution contract

| Dimension | Value |
| --- | --- |
| Benchmark | Terminal-Bench 2.1; 89 explicit tasks at revision `d49e28f1e4ddd13d289e85a5f312a66750951932` |
| Model | `deepseek-v4-flash` on every arm |
| Reasoning | `max`; provider thinking enabled |
| Repetitions | 1 |
| Verifier | Official task-native Terminal-Bench verifier |
| Deadline | Each task's native agent timeout ×1 |
| Max steps | 100,000 |
| Web tools | Removed from the provider-visible tool surface |
| Shell networking | Enabled, with benchmark-contamination egress filtering |
| Permissions | Non-interactive benchmark execution |
| Selection | Valid scored attempts; authorized infrastructure replacements and recorded metric recovery |

The harnesses retain their native prompts, tool schemas, context management, process lifecycle, and
execution loops. The result compares complete harness systems around one model; it is not a
single-component ablation.

## Outcome accounting and recovery

The eight-arm result was assembled from the full cohort plus bounded infrastructure, usage, and
trajectory recovery runs. The final eight-arm trajectory manifest records 712/712 cells with a
physical trajectory artifact and no missing selected cell.

DSH initially recorded 61/89. Real-machine inspection identified three Eval-specific defects:

1. A five-minute DSH Bash timeout interrupted package installation and left `dpkg` unusable for
   verification.
2. Package installation inherited an interactive `tzdata` configuration path instead of the
   benchmark's non-interactive execution contract.
3. DSH and the Eval relay terminated task-created background services before the shared-environment
   verifier could reach them.

Commit `28ebe0949` deferred Bash lifetime to the benchmark deadline, made package installation
non-interactive, and preserved background descendants only after successful DSH exit. Seven
affected cells were rerun. Four changed from fail to pass:

- `hf-model-inference`
- `merge-diff-arc-agi-task`
- `polyglot-c-py`
- `regex-log`

Three remained genuine verifier failures:

- `dna-assembly`
- `extract-moves-from-video`
- `torch-pipeline-parallelism`

The repaired DSH result is 65/89.

## Caveats

- This is one repetition over one fixed suite.
- DSH was a configuration-aligned follow-up run, not a ninth arm started simultaneously with the
  original eight-arm cohort.
- Some persisted trajectories hit the Eval recording limit. This affects replay completeness, not
  the official verifier score used here.
- The report uses the recorded token, cache, and cost aggregates directly, without replacing them
  with projections.
- Recovery admissions can sample a different model trajectory. The CSV freezes the selected final
  outcomes used by this report.

## Artifact pointers

| Artifact | Path |
| --- | --- |
| Original eight-arm run | `/mnt/deepswe/eval-runs/deepseek-v4-flash-eight-arm-full-24-903dd1b6-v1` |
| Eight-arm trajectory overlay | `/mnt/deepswe/eval-runs/deepseek-v4-flash-final-trajectory-overlay-8a1ab4635.json` |
| DSH full run | `/mnt/deepswe/eval-runs/deepseek-v4-flash-dsh-eightarm-comparable-full-89-v1` |
| DSH service repair | `/mnt/deepswe/eval-runs/deepseek-v4-flash-dsh-service-canary-v3-74c98a6ac` |
| DSH six-cell repair | `/mnt/deepswe/eval-runs/deepseek-v4-flash-dsh-verifier-fix-retry-6-v4-28ebe0949` |
| DSH Eval bundle | `/mnt/deepswe/maka-eval-dsh-verifier-fix-74c98a6ac` |
| DSH toolchain | `/mnt/deepswe/toolchains/deepseek-harness-0.1.0-rc.6-bullseye-v3` |

The DSH toolchain fingerprint is
`sha256:a0882b448718ddfb7b64e33a12369c92b0064baf8388fe08a8ff64fe3dd98896`.

## Integrity and verification

- CSV rows: 89
- Unique task ids: 89
- Recomputed pass totals: 73, 69, 66, 65, 63, 60, 58, 53, 49
- All-nine passes: 28
- All-nine failures: 5
- CSV SHA-256:
  `c27c3bcbfc3ebe8e21cc250dc409f02f49ae055032eaf2f19fd6349986e94e6a`
- DSH repair code: `28ebe0949`
- DSH repair verification: Eval Node 36/36; Python relay/policy/artifact 33/33; lint,
  format, and Eval typecheck passed
