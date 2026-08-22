# DeepSWE 1.1 — DeepSeek V4 Flash: Maka vs OpenCode

This report compares Maka and OpenCode as two agent harnesses around the same DeepSeek V4 Flash model on all 113 DeepSWE 1.1 tasks. It records the frozen experiment, accepted outcomes, paired inference, outcome-normalized economics, and the coverage gaps required to reconstruct the final score.

**Run id:** `deepseek-v4-flash-maka-vs-opencode-deepswe-full-v1`

**Local artifacts (git-excluded):** `/mnt/deepswe/runs/full/deepseek-v4-flash-maka-vs-opencode-deepswe-full-v1/`

**Metric:** end-to-end pass@1 by the official task verifier

**Status:** `completed_with_gaps` — 226/226 cells attempted, 223 model-scored, 3 unscored infrastructure cells, and no missing final usage

**Per-task outcomes:** [`deepswe-1.1-deepseek-v4-flash-maka-vs-opencode.csv`](./deepswe-1.1-deepseek-v4-flash-maka-vs-opencode.csv)

## TL;DR

- **Maka passed 52/111 scored tasks (46.85%); OpenCode passed 40/112 (35.71%).** On the 110 fully paired tasks the delta is 12.73 percentage points in Maka's favor.
- The paired outcomes were 34 Maka-only passes, 20 OpenCode-only passes, and 56 ties. An exact two-sided McNemar test on the 54 discordant pairs gives **p = 0.0759**. **This does not reach the conventional 0.05 threshold: on this suite the pass-rate difference is not statistically distinguishable from chance.** The point estimate favors Maka; the test does not license a claim of superiority.
- This contrasts with the same two harnesses on Terminal-Bench 2.1, where the discordant split was 16:4 and **p = 0.0118**. The sample sizes are comparable (54 vs 20 discordant pairs); what differs is the *lopsidedness* — 63% here versus 80% there. **Harness advantage is task-distribution dependent.**
- The observed accepted-dataset API-equivalent **cost per pass differs materially**: **$0.2358 for Maka and $0.3196 for OpenCode**, i.e. OpenCode costs 35.5% more per successful task. Cost per *attempted* task is effectively identical ($0.1115 vs $0.1104). No cost-equivalence test was performed; these are descriptive point estimates.
- Budget exhaustion was **0% on both arms** (0/111 and 0/112), unlike the Terminal-Bench run where it affected 16.85% / 26.97%. The DeepSWE per-task agent budget of 5400 s was not a binding constraint for either harness.

## Results

End-to-end pass@1 is the primary result.

| Primary result | Maka | OpenCode | Candidate − baseline |
| --- | ---: | ---: | ---: |
| End-to-end pass@1 | **52/111 (46.85%)** | **40/112 (35.71%)** | **−11.13 pp** |
| Paired end-to-end pass@1 (110 pairs) | **52/110 (47.27%)** | **38/110 (34.55%)** | **−12.73 pp** |

The paired outcome table over the 110 tasks scored on both arms is:

| | OpenCode pass | OpenCode fail | Total |
| --- | ---: | ---: | ---: |
| Maka pass | 18 | 34 | 52 |
| Maka fail | 20 | 38 | 58 |
| Total | 38 | 72 | 110 |

For the exact McNemar test, the null assigns equal probability to either direction among discordant pairs. With 34 Maka-only and 20 OpenCode-only outcomes, the two-sided exact binomial probability is `2 × P[Binomial(54, 0.5) ≤ 20] = 0.075905`. The test treats the 113 benchmark tasks as the paired units.

**Interpretation.** At α = 0.05 this run does **not** establish a pass-rate difference between the two harnesses on DeepSWE 1.1. The 12.73 pp point estimate is the best available estimate of the effect, but a 34:20 discordant split is reachable by chance roughly 8% of the time under the null. Reporting this as "Maka outperforms OpenCode" would overstate the evidence; reporting it as "no difference" would understate the point estimate. The accurate statement is that the direction favors Maka and the magnitude is not resolved by this sample.

## Diagnostic decomposition

| Diagnostic | Maka | OpenCode | Candidate − baseline |
| --- | ---: | ---: | ---: |
| Non-budget Conditional Pass Rate | 52/110 (47.27%) | 38/110 (34.55%) | −12.73 pp |
| Budget Exhaustion Rate | 0/111 (0%) | 0/112 (0%) | 0 pp |

Because no cell on either arm exhausted its budget, the non-budget conditional denominator excludes zero pairs and coincides exactly with the paired end-to-end result. On this suite the diagnostic carries no additional information — it is reported for comparability with the Terminal-Bench run, where budget exhaustion was a substantial component of the gap.

This is a meaningful negative finding: on Terminal-Bench 2.1 the two arms differed by 10.11 pp in budget exhaustion, and that dimension accompanied the headline gap. **On DeepSWE the entire observed difference sits in solution quality, not in deadline behavior.**

## Outcome-normalized economics

| Economic result | Maka | OpenCode |
| --- | ---: | ---: |
| Accepted-dataset API-equivalent **cost per pass** | **$0.235800** | **$0.319574** |
| Cost per fully metered task | $0.111469 | $0.110398 |
| Passed tasks | 52 | 40 |
| Recorded cost (USD) | $12.2616 | $12.1438 |

The two arms spent nearly the same money ($12.26 vs $12.14, a 1.0% difference) and the same amount per attempted task (1.0% difference), but Maka converted that spend into 30% more passes. **The cost-per-pass gap of 35.5% is therefore driven by effectiveness, not by resource efficiency.**

The resource footprint behind that outcome:

| Resource diagnostic | Maka | OpenCode |
| --- | ---: | ---: |
| Total tokens | 2,204,254,471 | 2,413,050,907 |
| Cached input tokens | 2,174,816,896 | 2,389,890,048 |
| Uncached input tokens | 17,808,556 | 10,369,028 |
| Output tokens | 11,629,019 | 12,791,831 |
| Cache-hit share of input | 99.19% | 99.57% |
| Mean agent steps | 165 | 152 |

A non-obvious result: **Maka consumed 8.6% fewer total tokens but 71.7% more uncached input tokens.** Maka enables active and stale tool-result pruning, which rewrites conversation history and therefore invalidates the shared prompt prefix that prompt caching depends on. The pruning buys a smaller context at the cost of more frequent cache misses, and since uncached input is priced 50× higher than cache hits ($0.145/M vs $0.0029/M), the two effects nearly cancel. This is a genuine engineering trade-off, not an efficiency ranking.

Costs are cache-aware API-equivalent estimates from the pricing identity frozen in the manifest: $0.145 per million uncached input tokens, $0.0029 per million cache-hit input tokens, $0 per million cache-write tokens, and $0.29 per million output tokens. They are not a billing invoice.

## Frozen setup

| Dimension | Value |
| --- | --- |
| Benchmark | DeepSWE 1.1, revision `6db64a40f3318d8659238ff34a8cc4b491c49205`; all 113 tasks |
| Executor | Pier 0.3.0 (Docker environments, per-task Squid egress proxy) |
| Task-source fingerprint | `sha256:973091a18c2045494bab4c4d5732170ebeb222227a16516cfdf08fda56b1fd82` |
| Run fingerprint | `sha256:73dfbc27fda789270422d5112a8d6df20f1ece020c80195ebb1e01262ba9a00e` |
| Subject fingerprint | `sha256:1e6786232467ab052f7c22eb0174e57e80d029395f8e5b4b4dae63c0427ea09b` |
| Toolchain fingerprint | `sha256:a03693a96884e3c4f5751e5daad74a1ff445f9fe9e94ff4969aebee75f003a8b` |
| Model | `deepseek-v4-flash` through the DeepSeek provider on both arms |
| Reasoning effort | `max` on both arms |
| Repetitions | 1 |
| Metric | Paired pass@1 |
| Task order | `sha256-rank-v1`, seed `deep-swe-1.1-full:deepseek-v4-flash:harness-comparison:v1` |
| Deadline policy | Task-native agent timeout ×1 (5400 s); 30 s agent settlement grace; 900 s outer grace |
| Verifier | Task-native, `environment_mode = "separate"` on all 113 tasks; 1800 s verifier timeout |
| Per-task resources | 2 vCPU / 8192 MiB / 20480 MiB storage per environment; `gpus = 0`; `allow_internet = false` |
| Pair execution | Up to 32 task pairs concurrently; arms run **sequentially** within a pair (at most 32 cells concurrently) |
| Maka arm | `maka_agent:MakaAgent`; active and stale tool-result pruning enabled; semantic compact off |
| OpenCode arm | `opencode_agent:MakaOpenCodeAgent` 1.17.18; pure mode; automatic permissions; `max` variant |
| Billing mode | Metered, using the frozen DeepSeek V4 Flash pricing identity above |
| Host | Azure `Standard_D96d_v5`, 96 vCPU / 377 GiB, x86_64, no GPU; dedicated to this run |

This is a same-model harness comparison, not an isolated model evaluation and not a same-system/same-tool ablation. The two arms retain their native agent instructions, tool behavior, context management, and execution loops. The observed difference is therefore attributable to the compared harness systems as a whole; this run does not rank individual harness differences as causes.

Note the execution-mode difference from the Terminal-Bench run: arms here ran **sequentially within each pair** rather than in parallel. This eliminates intra-pair resource contention at the cost of exposing the two arms to potentially different machine load. Peak observed load was 26 of 96 cores with 42 GiB of 377 GiB memory in use, so contention was not a binding factor in either direction.

## Outcome accounting

The accepted dataset selects the latest authorized terminal outcome for each arm/task cell under the immutable run fingerprint. The attempts WAL contains **226 Agent admissions** — exactly one per cell. No cell received a retry, and no adjudication was applied.

Three cells terminated as unscored infrastructure failures and are excluded from all denominators:

| Cell | Class | Note |
| --- | --- | --- |
| `ab-maka-r0-mnamer-daemon-watch-lifecycle` | `infra_error` | Non-zero agent exit |
| `ab-maka-r0-pwntools-tube-multiplexing` | `infra_error` | Verifier timeout (1800 s) |
| `ab-opencode-r0-langchain-request-coalescing` | `infra_error` | See known-defect note below |

Because two of the three fell on the Maka arm and one on the OpenCode arm, the exclusions are close to symmetric and do not materially bias the paired comparison. The paired denominator is 110 rather than 113 as a result.

The runner exits non-zero on `completed_with_gaps` rather than silently reporting success. That non-zero exit is the reason the run is labeled with gaps; it does not indicate a failed experiment.

## Known benchmark defects affecting interpretation

DeepSWE 1.1 has documented task-level defects that place a floor under both arms' failure counts. These are properties of the benchmark, not of either harness:

- **`langchain-request-coalescing` is unpassable** ([datacurve-ai/deep-swe#17](https://github.com/datacurve-ai/deep-swe/issues/17)): the base image ships a stale syrupy snapshot, so the baseline gate fails at the base commit and no candidate — including the reference solution — can score. In this run the Maka arm scored it a failure and the OpenCode arm terminated as infrastructure failure.
- **69 of 113 tasks collect base tests by wildcard** (`pytest tests/`, `go test ./...`, `cargo test`) while the verifier reset only restores files touched by `test.patch` ([#31](https://github.com/datacurve-ai/deep-swe/issues/31)). Any stray or broken test file an agent leaves behind causes a non-zero base exit and a scored failure even when the task was solved. This inflates false negatives on both arms by an unmeasured amount.
- An independent audit ([#52](https://github.com/datacurve-ai/deep-swe/issues/52)) reproduced 112/113 reference solutions on native amd64, so the defect surface is bounded but non-zero.

## Failure-shape observation

Both arms fail predominantly by narrow margins rather than by complete non-solution:

| Failure shape | Maka | OpenCode |
| --- | ---: | ---: |
| Partial pass (some fail-to-pass tests satisfied) | 50 | 57 |
| Zero pass (no fail-to-pass test satisfied) | 9 | 15 |
| Mean completion among partial passes | 83% | 88% |

DeepSeek V4 Flash reaches a substantially correct solution on most tasks under both harnesses and is stopped by boundary conditions and detail. This compresses the achievable gap between harnesses and is a plausible mechanical explanation for why the discordant split here (63%) is less lopsided than on Terminal-Bench (80%).

For external calibration, 46.85% places this configuration between `glm-5.2 [max]` (44%) and `gemini-3.6-flash [high]` (49%) on the [official DeepSWE leaderboard](https://deepswe.datacurve.ai/), whose v1.1 SOTA is `claude-opus-5 [max]` at 74%.

## Caveats

- This is one repetition over a fixed 113-task suite. The exact paired p-value describes asymmetry on this suite and does not establish universal superiority — nor, at p = 0.0759, does it establish a difference at all.
- The arms share the model, provider, task order, instructions, verifier, deadline policy, and resource limits, but they intentionally retain native harness behavior. This is not a single-variable component ablation.
- Non-budget Conditional Pass Rate coincides with the paired headline here because no cell exhausted its budget. It carries no independent information in this run.
- Cost per pass is an accepted-dataset point estimate from recorded usage and frozen API-equivalent prices. "35.5% more expensive per pass" describes the observed values, not a formal interval.
- Three cells are unscored infrastructure failures. Their exclusion is disclosed above because omitting it would make the 110-pair denominator non-reconstructible.
- No Oracle registry snapshot was configured. Oracle annotations are absent for all 113 tasks; the official DeepSWE verifier remains the scoring authority.
- Known benchmark defects (above) place an unmeasured floor under both arms' failure counts. They apply symmetrically to the two arms and therefore should not bias the paired direction, but they do compress the achievable spread.

## Integrity

SHA-256 hashes of the frozen local evidence and committed outcome projection:

| Source | SHA-256 |
| --- | --- |
| `harness-ab-manifest.json` | `f4ede9b235b3d3f46e71a2c05db486f21efb52fa2ba813fe33983000e88b33db` |
| `harness-ab-report.json` | `08246353723a11af4edd353a595a5d22c5cdb31879f79cb8a9eb731f59287420` |
| `controller/results.jsonl` | `1ed9ff7c2e3e45ce9a17590b0c36d464b89ea56a9bc4a175e6e5fd2d7f8bbe3e` |
| `controller/results.jsonl.attempts.jsonl` | `80444436400f0c69d464213e647b5d9269330957d86b2cfe3dfa0c08e63dcad9` |
| Committed outcome CSV | `caeb18c74e8ab0c5a7804acf62926bf28faa13117dec44d533c78c3ba5b77290` |

## Artifact pointers

| Artifact | Local path |
| --- | --- |
| Generated report | `/mnt/deepswe/runs/full/deepseek-v4-flash-maka-vs-opencode-deepswe-full-v1/harness-ab-report.{json,csv,md}` |
| Immutable manifest | `.../harness-ab-manifest.json` |
| Controller WAL | `.../controller/results.jsonl` and `.../controller/results.jsonl.attempts.jsonl` |
| Per-cell trajectories | `.../jobs/*/ab-{arm}-r0-{task}/{task}/trial/*/agent/trajectory.json` |
| Per-cell candidate patches | `.../jobs/*/ab-{arm}-r0-{task}/{task}/trial/*/artifacts/model.patch` |
| Per-cell verifier evidence | `.../trial/*/verifier/{reward.json,ctrf.json,base-ctrf.json,new-ctrf.json,test-stdout.txt}` |
| Per-request provider telemetry | `.../{task}/provider-request-telemetry.json` |
| Per-step provider payloads (Maka arm only) | `.../agent/maka-task-run/runs/artifacts/*-provider-request-step-*.json` |

Full artifacts total 82 GB, of which 61.5 GB is Maka-arm submitted repository snapshots. Trajectories, patches, verifier evidence, and telemetry total roughly 20 GB.
