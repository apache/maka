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

# Terminal-Bench 2.1 — DeepSeek V4 Flash: Maka vs Codex vs Claude Code vs Reasonix

This report compares four agent harnesses around the same DeepSeek V4 Flash model on all 89 Terminal-Bench 2.1 tasks. Every arm ran inside the task container under the same executor, the same task-native deadline policy, and the same package mirror, so the only variable that moves between arms is the harness itself.

**Run id:** `deepseek-v4-flash-4arm-tbench-2.1-full-v1`

**Metric:** end-to-end pass@1 by the official task verifier

**Status:** `completed_with_gaps` — 353/356 cells model-scored; the three unscored cells are Reasonix infrastructure and plumbing failures that survived the retry policy

**Per-task outcomes:** [`terminal-bench-2.1-deepseek-v4-flash-four-arm.csv`](./terminal-bench-2.1-deepseek-v4-flash-four-arm.csv)

The experiment was tracked in [issue #1970](https://github.com/maka-agent/maka-agent/issues/1970).

## TL;DR

- **Codex passed 70/89 (78.65%), Maka 65/89 (73.03%), Claude Code 57/89 (64.04%), Reasonix 55/89 (61.80%).**
- **The Codex–Maka gap is not statistically significant.** Of 19 discordant pairs, Codex won 12 and Maka 7; an exact two-sided McNemar test gives **p = 0.359**. Only two of the six pairwise comparisons reach significance: Codex over Claude Code (p = 0.0072) and Codex over Reasonix (p = 0.0026).
- **An independent earlier run agrees, including on the non-significance.** Over the same 89 tasks it scored Codex 67, Maka 60, Claude Code 57, with Codex–Maka at p = 0.210. Codex is the one arm configured identically in both runs, and **19% of its tasks changed outcome between them while its net score moved by 3** — that is the noise floor any five-task claim has to clear.
- **Maka is the cheapest arm per pass at $0.03215**, ahead of Codex ($0.03339), Reasonix ($0.04051), and Claude Code ($0.04800), and it is the fastest arm at the median cell (332.8 s against Codex's 411.7 s).
- On the 60-task subset where no arm exhausted its budget, the ordering inverts at the top: **Claude Code 90.00%, Codex 88.33%, Maka 86.67%, Reasonix 75.00%.** Claude Code has the highest conditional pass rate and the worst overall score, because it exhausted its budget on 24/89 tasks (26.97%) — more than double any other arm.
- Three of the four arms are close in solution quality once they finish. The headline spread is driven mostly by whether an arm finishes inside its deadline, not by whether it can solve the task.

## Results

End-to-end pass@1 is the primary result. Budget-exhausted cells remain scored failures in its denominator.

| Arm | Pass@1 | Passed / evaluated | Budget exhausted | Verification failed | Unscored |
| --- | ---: | ---: | ---: | ---: | ---: |
| Codex | **78.65%** | 70 / 89 | 9 | 10 | 0 |
| Maka | **73.03%** | 65 / 89 | 11 | 13 | 0 |
| Claude Code | **64.04%** | 57 / 89 | 24 | 8 | 0 |
| Reasonix | **61.80%** | 55 / 89 | 13 | 18 | 3 |

Reasonix is the only arm with unscored cells: two infrastructure failures and one plumbing failure survived the retry policy. Its pass@1 is reported over all 89 tasks; over the 86 it actually completed the rate is 63.95%. The other three arms recorded zero infrastructure failures.

## Pairwise significance

Each comparison uses the exact two-sided McNemar test over discordant task pairs, treating the 89 benchmark tasks as the paired units.

| Comparison | A-only passes | B-only passes | Discordant | p |
| --- | ---: | ---: | ---: | ---: |
| Codex vs Reasonix | 19 | 4 | 23 | **0.0026** |
| Codex vs Claude Code | 17 | 4 | 21 | **0.0072** |
| Maka vs Reasonix | 17 | 7 | 24 | 0.0639 |
| Maka vs Claude Code | 13 | 5 | 18 | 0.0963 |
| Maka vs Codex | 7 | 12 | 19 | 0.3593 |
| Claude Code vs Reasonix | 15 | 13 | 28 | 0.8506 |

Only the two Codex comparisons clear the 0.05 threshold. **The five-task Codex lead over Maka is within what this suite's noise can produce**: the paired outcomes are 58 shared passes, 7 Maka-only, 12 Codex-only, and 12 shared failures. Maka's advantages over Claude Code and Reasonix point in a consistent direction but do not reach significance either.

This is evidence about one frozen run over the fixed 89-task Terminal-Bench 2.1 suite. It is not proof of a universal ordering on other task distributions, other models, or repeated runs.

## Exclusive outcomes

**Maka only, 7:** `extract-elf`, `feal-differential-cryptanalysis`, `kv-store-grpc`, `protein-assembly`, `qemu-alpine-ssh`, `regex-chess`, `sanitize-git-repo`

**Codex only, 12:** `cancel-async-tasks`, `code-from-image`, `configure-git-webserver`, `dna-assembly`, `dna-insert`, `fix-git`, `largest-eigenval`, `make-mips-interpreter`, `mteb-leaderboard`, `pytorch-model-recovery`, `torch-pipeline-parallelism`, `write-compressor`

The two sets differ in kind, not only in size. On all 7 tasks Maka won alone, Codex produced a candidate and the verifier rejected it — none was a deadline loss. On the 12 tasks Codex won alone, Maka's failures split **8 verification failures against 4 budget exhaustions**. Two thirds of the gap is therefore wrong answers rather than unfinished work, which is the opposite of what the per-request timing shape below would predict on its own.

The complete accepted pass/fail outcome and failure class for every task is in the adjacent [CSV](./terminal-bench-2.1-deepseek-v4-flash-four-arm.csv); prompts, payloads, traces, and verifier output are not committed.

## Diagnostic decomposition

These metrics diagnose where the observed gaps appear. Neither replaces end-to-end pass@1.

| Diagnostic | Maka | Codex | Claude Code | Reasonix |
| --- | ---: | ---: | ---: | ---: |
| Non-budget conditional pass rate | 52/60 (86.67%) | 53/60 (88.33%) | **54/60 (90.00%)** | 45/60 (75.00%) |
| Budget exhaustion rate | 11/89 (12.36%) | 9/89 (10.11%) | **24/89 (26.97%)** | 13/89 (14.61%) |

The conditional denominator excludes any task where *any* arm exhausted its budget, leaving the same 60 tasks for all four. It is not an "unlimited-time pass rate": the remaining tasks still ran under their original task-native deadlines, and the excluded set is not random — it is enriched for hard tasks.

The two rows tell different stories. On the conditional subset, Maka, Codex, and Claude Code sit within 3.33 percentage points of each other, and the ordering of the top three reverses relative to the headline. What separates them in the headline is the second row: Claude Code exhausts its budget on more than a quarter of the suite, over twice the rate of Codex.

These observations decompose the gap; this run does not establish their causes.

## Outcome-normalized economics

Cost per pass normalizes recorded usage by successful benchmark outcomes. It includes spending on scored failures.

| Arm | Total cost | Passed | Cost per pass |
| --- | ---: | ---: | ---: |
| Maka | $2.0895 | 65 | **$0.03215** |
| Codex | $2.3376 | 70 | $0.03339 |
| Reasonix | $2.2281 | 55 | $0.04051 |
| Claude Code | $2.7363 | 57 | $0.04800 |

Maka is the cheapest per pass despite ranking second on pass@1. Its margin over Codex is 3.7%; the gap to Claude Code is 49%. No equivalence test was performed, so these are descriptive point estimates from a single run.

The resource footprint behind that result:

| Resource diagnostic | Maka | Codex | Claude Code | Reasonix |
| --- | ---: | ---: | ---: | ---: |
| Input tokens | 181,448,639 | 295,168,443 | 244,477,053 | 240,741,904 |
| Cached input tokens | 177,684,352 | 291,031,168 | 240,396,288 | 237,451,776 |
| Cache-hit share of input | 97.93% | 98.60% | 98.33% | 98.63% |
| Output tokens | 3,546,226 | 3,081,715 | 4,991,091 | 3,663,490 |

Maka reaches 93% of Codex's score on **61% of its input tokens**. Because DeepSeek prices cache hits at 2% of uncached input, that difference is a smaller share of the bill than of the token count, but it is the mechanism behind Maka's lower total spend at a higher output volume.

Usage was metered by a per-cell host proxy that parses the provider's SSE stream. Clients that close the connection after receiving the terminal event are common — 40% of Reasonix requests end this way — and their usage is retained. Across the run, 2 of 412 Reasonix requests are the only ones without recorded usage.

Costs are cache-aware API-equivalent estimates from the pricing identity frozen in the manifest: $0.145 per million uncached input tokens, $0.0029 per million cache-hit input tokens, and $0.29 per million output tokens. They are not a billing invoice.

## Per-request shape

The four harnesses differ sharply in how they spend a task budget.

All four columns come from the host proxy's per-request telemetry, so they are mutually comparable.

| Arm | Requests per cell | Output tokens per request | Reasoning tokens per request | Seconds per request |
| --- | ---: | ---: | ---: | ---: |
| Codex | 44.3 | 781 | 543 | 9.1 |
| Reasonix | 41.6 | 1,000 | 745 | 11.5 |
| Maka | 37.4 | 1,064 | 778 | 10.7 |
| Claude Code | 32.8 | 1,708 | not itemized | 18.2 |

Codex takes the most steps and makes each one the smallest; Claude Code takes the fewest and makes each one the largest and slowest. Maka sits between them, spending 1.43× more reasoning per request than Codex. Anthropic's protocol does not itemize reasoning tokens, so Claude Code's reasoning column is empty rather than zero.

At the cell level this produces a distinctive duration profile:

| Arm | Median cell | Mean cell | p90 cell | Median share of task deadline consumed |
| --- | ---: | ---: | ---: | ---: |
| Maka | **332.8 s** | 693.1 s | 1800.0 s | 0.309 |
| Codex | 411.7 s | 582.8 s | 1334.9 s | 0.303 |
| Reasonix | 428.7 s | 658.2 s | 1577.5 s | 0.363 |
| Claude Code | 544.7 s | 840.2 s | 1800.6 s | 0.416 |

Maka has the fastest median cell and the second-slowest mean. The two statistics are not in conflict: on the typical task Maka finishes first and consumes essentially the same share of the deadline as Codex (0.309 against 0.303), and the mean is pulled up by a heavier tail of cells that run to the deadline.

Under a hard deadline this shape has consequences at the tail. On `write-compressor`, whose task-native agent budget is 900 s, Maka spent 890 s inside the model with only 6 s in tools and exhausted the budget after 20 requests; Codex finished the same task in 540 s across 66 requests. Denser steps leave less room to recover from a wrong turn.

## Cross-run stability

An earlier three-arm run over the same 89 tasks and the same model (`deepseek-v4-flash-3arm-tbench-2.1-full-v7`) provides one independent repetition for Codex, Maka, and Claude Code. It predates this branch: Maka ran host-side, no package mirror was applied, and its Claude Code arm lost 17 cells to infrastructure failures. Only the Codex arm is configured identically in both runs.

| Arm | Three-arm run | Four-arm run | Tasks flipping outcome |
| --- | ---: | ---: | ---: |
| Codex | 67/89 (75.28%) | 70/89 (78.65%) | 17 (19.10%) |
| Maka | 60/89 (67.42%) | 65/89 (73.03%) | 19 (21.35%) |
| Claude Code | 57/89 (64.04%) | 57/89 (64.04%) | 18 (20.22%) |

The Codex row is the interpretable one, and it is the most useful number in this report. Its configuration did not change and it recorded no infrastructure failures in either run, yet **19% of tasks changed outcome between the two runs while the net score moved by 3**. Roughly a fifth of this suite is decided by run-to-run variation rather than by any property of the harness under test.

That is the scale against which the five-task Codex–Maka gap has to be read, and it agrees with the significance tests: the same comparison in the three-arm run gives 15 Codex-only against 8 Maka-only, **p = 0.210** — again not significant, again in Codex's favour. Two independent full runs put Codex nominally ahead of Maka and neither can distinguish them.

The Maka and Claude Code rows cannot be read the same way. Maka's placement and package sourcing both changed between the runs, so its +5 confounds those changes with variance. Claude Code's identical headline conceals a different denominator: 17 of its three-arm cells never scored.

## What this run establishes about Maka

Stated as claims this run supports, with the evidence attached to each.

1. **Maka is competitive with Codex on solution quality, and this suite cannot separate them.** 65 against 70 passes, p = 0.359, against a measured 19% cross-run flip rate. Two independent full runs both put Codex nominally ahead and neither reaches significance.
2. **Maka is the most economical arm per successful task.** $0.03215 per pass, the lowest of the four, on 61% of Codex's input tokens. Codex buys its extra five passes at 12% higher total spend.
3. **Maka is the fastest arm at the median cell.** 332.8 s against 411.7 s for Codex, 428.7 s for Reasonix, and 544.7 s for Claude Code, while consuming the same median share of the task deadline as Codex.
4. **Maka's execution was clean.** Zero infrastructure failures, zero retry admissions, and zero unscored cells across all 89 tasks — matched only by Codex. Claude Code required one retry and Reasonix five, three of which still failed.
5. **When Maka wins, it wins on correctness.** All 7 tasks Maka passed and Codex failed were Codex verification failures, not Codex deadline losses.

What this run does **not** establish: that Maka is better than Codex, that any of these margins would survive a repetition, or that the mechanisms above cause the outcomes. Every claim here is a description of one frozen run.

## Where Maka improves next

The failure decomposition points somewhere different from where the timing story alone would point.

**First, solution correctness on tasks Codex gets right.** Of the 12 tasks Codex passed and Maka did not, **8 were verification failures and only 4 were deadline losses**. Maka produced a candidate, submitted it, and the official verifier rejected it. That is the larger of the two buckets and it is not a speed problem. The tasks are listed under [Exclusive outcomes](#exclusive-outcomes) and each has a complete trace in the archived run; a per-task read of those 8 is the highest-value next investigation this dataset supports.

**Second, reasoning volume per step under a hard deadline.** Maka spends 778 reasoning tokens per request against Codex's 543, and takes fewer, denser steps. On the four tasks Maka lost to the deadline this is decisive — `write-compressor` spent 99% of its 900 s inside the model. The open question is causal and is not answered here: the same model at the same `max` effort produces substantially more reasoning text under Maka's scaffold than under Codex's, and two candidate explanations (loop repetition and context growth) were checked against the three-arm traces and ruled out. Tracking continues in [issue #1970](https://github.com/maka-agent/maka-agent/issues/1970).

**Third, deadline awareness as a policy, not a timeout.** Maka's median cell consumes 0.309 of its task deadline, so the budget is not generally tight; the 11 exhausted cells are a tail, not a trend. A harness that could detect it was in that tail and shift toward cheaper, more frequent verification steps would convert deadline losses into scored attempts without changing the typical case. This run measures the tail but does not evaluate any such policy.

**Fourth, more repetitions before any of these are treated as settled.** The 19% cross-run flip rate means a single run cannot validate a change worth fewer than roughly ten tasks. Any of the above should be measured with repetitions, not with one more full run.

## Frozen setup

| Dimension | Value |
| --- | --- |
| Benchmark | Terminal-Bench 2.1, revision `d49e28f1e4ddd13d289e85a5f312a66750951932`; all 89 tasks |
| Task-source fingerprint | `sha256:456826aa4c47ed309716c964c96d2a3acc998764ebc84f3e8449c807d74bd4e7` |
| Run fingerprint | `sha256:869d39bb82d61462afabec5ccc6d9560c9aa19287041a1d46f6c5d7c66fd3fb4` |
| Toolchain fingerprint | `sha256:7b21118862eb823a7af9c7d90ead64ef459f8a353b7aebae1b164dde6166eb60` |
| Model | `deepseek-v4-flash` through the DeepSeek provider on all four arms |
| Reasoning effort | `max` on all four arms |
| Repetitions | 1 |
| Metric | Paired pass@1 by the official verifier |
| Deadline policy | Task-native agent timeout ×1; 30 s agent settlement grace; 900 s outer setup and teardown grace |
| Task-native budgets | 900 s on 48 tasks, 1800 s on 17, 3600 s on 13, 1200 s on 5, 2400 s on 2, and one each at 600 s, 750 s, 7200 s, and 12000 s |
| Attempt policy | One accepted model attempt per arm/task; only infrastructure-invalid admissions may be replaced |
| Placement | All four arms execute inside the task container |
| Pair execution | 6 task groups concurrently, arms parallel within a group, at most 24 cells concurrently |
| Task order | `sha256-rank-v1` over seed `terminal-bench-2.1:deepseek-v4-flash:harness-comparison:v1` |
| Package mirror | `archive.ubuntu.com` and `security.ubuntu.com` redirected to `mirrors.tencentyun.com` for every arm |
| Billing mode | Metered, using the frozen DeepSeek V4 Flash pricing identity above |
| Maka arm | `maka_agent:MakaAgent`; `openai-chat`; external system prompt `default-headless`; continuation off; active and stale tool-result prune at a 2,048 estimated-token threshold; semantic compact off; `harbor-local` isolation |
| Codex arm | `codex_agent:MakaCodexAgent` 0.146.0; `openai-responses`; external system prompt none; `container-full-access` permissions |
| Claude Code arm | `claude_code_agent:MakaClaudeCodeAgent` 2.1.220; `anthropic-messages`; external system prompt none; `bypassPermissions` |
| Reasonix arm | `reasonix_agent:MakaReasonixAgent` 1.19.4; `openai-chat`; `stream-json` output; external system prompt none; `auto` permissions |

Redirecting apt is a variance-control measure, not a performance aid. The same command took 16 s or 300 s from the same host depending on which upstream path it landed on, and that noise is charged against whichever agent happened to need more packages. The mirror address enters the manifest fingerprint, so runs with and without it are distinct experiments.

This is a same-model harness comparison, not an isolated model evaluation and not a same-system/same-tool ablation. The arms retain their native agent instructions, tool behavior, context management, and execution loops. Two asymmetries are worth naming explicitly: Maka is the only arm carrying an external system prompt (`default-headless`, where the others send none), and Maka is the only arm running a context-budget tool-result prune policy. The observed differences are attributable to the compared harness systems as a whole; this run does not rank individual harness differences as causes.

## Outcome accounting

The controller WAL records **362 Agent admissions** against 356 scheduled cells: 356 initial admissions plus six infrastructure retries. Those retries covered one Claude Code cell (`custom-memory-heap-crash`, which then completed) and five Reasonix cells (`cancel-async-tasks`, `filter-js-from-html`, and `fix-ocaml-gc` completed; `adaptive-rejection-sampler` and `regex-chess` failed again). No cell received a third admission. Reasonix `pytorch-model-recovery` failed at the plumbing layer and was not retried.

Maka and Codex each received exactly 89 admissions with zero retries and zero infrastructure failures.

The final ledger is 353 `task_completed`, 8 `task_infra_failed`, and 1 `task_plumbing_failed` events, of which the three surviving failures are the unscored cells reported above.

## Limitations

- Two runs of this suite exist, but only the Codex arm is configured identically across both; the comparison in this report rests on one run of the four-arm configuration. Given the 19% cross-run flip rate measured above, differences of this size should not be treated as settled by either run alone.
- The task-native deadline is a material parameter, not a neutral one. It binds hardest on Claude Code (26.97% exhaustion) and would likely change the ordering if relaxed.
- Reasonix contributes three unscored cells, so its comparisons rest on 86 shared tasks rather than 89.
- Maka carries an external system prompt and a tool-result prune policy that the other three arms do not. This is a documented live harness asymmetry, not a controlled variable, and the run has no prune-off or prompt-off control.
- Cost per pass uses provider list pricing applied to metered usage, not billed invoices.
- Pairwise McNemar tests are reported without multiple-comparison correction. Applying a Bonferroni correction across the six comparisons moves the threshold to 0.0083; both Codex results survive it (0.0026 and 0.0072) and no other comparison approaches it.
- Per-request telemetry and the harness token summary disagree on Codex's total reasoning volume (2.14M versus 1.57M tokens); the two agree for Maka. The cause was not identified, so this report makes no cross-source total-volume claim and compares per-request figures only within the telemetry source.
- No external Oracle registry snapshot was configured, so Oracle annotations are missing for all 89 tasks. The official Terminal-Bench verifier remains the scoring authority.

## Integrity

SHA-256 hashes of the frozen local evidence and the committed outcome projection:

| Source | SHA-256 |
| --- | --- |
| `harness-ab-manifest.json` | `aaa3099b365cff01658405d0fc0777aa3c719e8e4cb73627d23bfc124767e3cc` |
| `harness-cohort-report.json` | `52dff9d3212cbcc9bc927dd0cb280aded72f757e310e75de77f27242e130087e` |
| `harness-cohort-report.csv` | `bd04d3d0bbb3c2e9d0594d061e1ffc4cd1ba0706e21ddad9f95057415f7d3c2e` |
| Full run archive `four-arm-full-v1.tgz` | `0816483e35ae2cb85d283c7ee8d74af7e929d8b4898eca4cce877a1341832e95` |
| Committed outcome CSV | `d0a65eed5c3f8803271819797b292b39c4deaf59178ffbc21595299b740ccfc7` |

## Artifact pointers

Local, git-excluded, under `maka-eval/experiments/harness-ab/terminal-bench-2.1/`:

| Artifact | Path |
| --- | --- |
| Four-arm run archive | `deepseek-v4-flash-4arm-tbench-2.1-full-v1-20260805/four-arm-full-v1.tgz` |
| Generated cohort report | `deepseek-v4-flash-4arm-tbench-2.1-full-v1-20260805/harness-cohort-report.{json,csv,md}` |
| Immutable manifest | `deepseek-v4-flash-4arm-tbench-2.1-full-v1-20260805/harness-ab-manifest.json` |
| Controller WAL and attempts | `deepseek-v4-flash-4arm-tbench-2.1-full-v1-20260805/extracted/*/controller/results.jsonl{,.attempts.jsonl}` |
| Three-arm reference runs | `deepseek-v4-flash-3arm-tbench-2.1-full-20260804/` |
| Three-arm per-task deep dive | `deepseek-v4-flash-3arm-tbench-2.1-full-20260804/deepdive/` |

The committed CSV contains only the selected final pass/fail and failure-class projections; prompts, trajectories, provider payloads, raw logs, and traces are not published.
