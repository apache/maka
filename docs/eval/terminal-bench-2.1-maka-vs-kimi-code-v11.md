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

# Terminal-Bench 2.1 — Maka vs Kimi Code (v11)

Paired harness A/B on Terminal-Bench 2.1 with the same model on both arms. This document records the v11 full run: the accepted outcomes and how they were selected, why both absolute scores are a throughput-depressed lower bound, and what explains the relative gap.

**Run id:** `k3-maka-vs-kimi-code-tbench-2.1-full-v11`
**Local artifacts (git-excluded):** `~/.maka/eval/runs/k3-maka-vs-kimi-code-tbench-2.1-full-v11/`
**Metric:** pass@1 by Harbor reward
**Status:** `completed_with_gaps` (178/178 cells accepted and model-scored after recovery; oracle evidence missing)
**Per-task outcomes:** [`terminal-bench-2.1-maka-vs-kimi-code-v11.csv`](./terminal-bench-2.1-maka-vs-kimi-code-v11.csv)

## TL;DR

- **Headline (accepted outcomes):** Maka **62/89 (69.7%)**, Kimi Code **53/89 (59.6%)** — same model (`k3`) at **max** thinking effort, with thinking history retained on both arms. The Kimi Code headline is operator-adjusted: a mechanical first-verifier count is **50/89** (see Results).
- **Both absolute scores are a lower bound, not the model's ceiling.** Effective decode ran at ~34–37 output tok/s with heavy first-token latency, and 28 (Maka) / 33 (Kimi Code) of 89 tasks were killed at their task-native deadlines mid-generation; killed tasks passed only 14% / 15% of the time. Tasks that finished in time passed at **95.1%** (Maka) and **85.7%** (Kimi Code), against an **official 88.3%** reported for the same KimiCode harness. Under healthy throughput Maka would plausibly reach or exceed that reference and Kimi Code would plausibly land near it (projection below) — at which point Terminal-Bench 2.1 is close to saturated at the frontier.
- **The relative +10.1 pp gap (in Maka's favor) is harness asymmetry,** not thinking effort, thinking retention, or network. The main setting differences are Maka's **context-budget tool-result prune** (on, and measured firing), empty system + narrow foreground tools vs Kimi Code's full product CLI (~20KB system, full tool surface). The gap persists among finished-in-time tasks (95.1% vs 85.7%). Differences are listed, not ranked as score causes.

## Results

Accepted final outcomes (after the audited recovery layer below):

| Selection | Maka | Kimi Code | Kimi Code − Maka |
| --- | ---: | ---: | ---: |
| Accepted final outcomes | 62/89 (69.7%) | 53/89 (59.6%) | −9 tasks (−10.1 pp) |
| Mechanical first structured verifier | 62/89 (69.7%) | 50/89 (56.2%) | −12 tasks (−13.5 pp) |
| Reference: official Kimi K3 + KimiCode harness ([tech blog](https://www.kimi.com/blog/kimi-k3), accessed 2026-07-19) | — | 88.3% | — |

Paired outcomes (accepted): Maka exclusive pass **12**, Kimi Code exclusive pass **3**, both pass **50**, both fail **24** (ties 74).

This is a single-repetition run (`reps = 1`). All numbers are descriptive observations of one frozen run, not estimates of statistical superiority.

## Outcome accounting

The accepted dataset selects the last structured verifier outcome per arm/task cell after recorded recovery admissions. The attempts WAL contains **203 admissions**: 178 initial plus **25 recovery** (Maka 12, Kimi Code 13).

| Recorded recovery reason | Admissions | Changed selected pass/fail |
| --- | ---: | ---: |
| `operator_authorized_infrastructure_interruption` | 13 | 0 |
| `operator_authorized_terminal_infrastructure_failure` | 9 | 0 |
| `operator_authorized_verifier_infrastructure_misclassification` | 3 | 3 |

The three score-changing recoveries were all on the Kimi Code arm — `prove-plus-comm`, `hf-model-inference`, and `pypi-server` each first recorded a structured verifier failure, were invalidated by an operator as infrastructure misclassification, and passed on their replacement admissions. The WAL records the invalidation reason and prior admission id for each; the frozen run directory no longer retains the superseded trial directories, so the invalidation and replacement outcomes are verifiable but the operator's original judgment is not independently reconstructible.

The generated report's "178/178 attempted, 0 infraFailedCells" describes the accepted final dataset — not the physical admission count, and not the absence of infrastructure failures during the run. Run status is `completed_with_gaps` because final usage is absent for the Maka `adaptive-rejection-sampler` cell; economy aggregates therefore cover 88/89 metered pairs.

## Throughput: why the absolute scores are a lower bound

Agent budgets were task-native (timeout multiplier 1): 48 of 89 tasks at 900 s, the rest spread from 600 s to 12,000 s. Kills fired at the budget on both arms — Maka cells settle ~30 s early, Kimi Code cells run to the deadline (median 0.6 s past it). Both arms decoded far below what those budgets require:

| | Maka | Kimi Code |
| --- | ---: | ---: |
| Effective output tok/s, overall | ~37 (est.) | 34.0 (measured) |
| Effective output tok/s, median task | ~44 (est.) | 35.4 |
| Tasks killed at the deadline | 28 / 89 | 33 / 89 |
| Pass rate when killed | 14.3% (4/28) | 15.2% (5/33) |
| Pass rate when finished in time | **95.1% (58/61)** | **85.7% (48/56)** |

Deadline-killed tasks were still verified; a minority pass because the deliverable was already in place when the budget ran out.

Measurement notes. Kimi Code figures come from per-request provider-proxy telemetry: 1,267 requests with positive generation spans (of 1,300 recorded), 1.16M output tokens over 9.5 h of measured generation. The Maka path has no request-level telemetry, so its figures are estimated from runtime event-stream spans (first-to-last partial event per generation burst: 1.86M tokens over 13.8 h) — treat them as approximate.

First-token latency on the shared proxy path was heavy: median 13.7 s, p90 62.9 s, worst 1,023 s for a single request. With ~14 model requests per task, first-token waits alone consumed roughly 3 minutes of a 15-minute budget at the median. The mechanism is simple: at ~35 tok/s a task can only emit ~30K output tokens per 15 minutes of budget minus tool time and waits, so long-horizon tasks starve mid-generation — and the same starvation killed tasks even at 1,800–3,600 s budgets.

**Projection.** The official 88.3% was reported for the same product harness our Kimi Code arm ran (KimiCode, max reasoning effort). Our finished-in-time subsets pass at 95.1% (Maka) and 85.7% (Kimi Code); on the 49 tasks both arms finished in time, the rates are 95.9% and 89.8%. Under healthy throughput Maka would plausibly reach or exceed the official score, and Kimi Code would plausibly land near it. These subsets are enriched for shorter tasks, so no exact counterfactual is claimed — a healthy-network re-run is the decisive test.

**Benchmark headroom.** The official frontier is already compressed: the current top two leaderboard scores are 88.8% and 88.3% ([llm-stats](https://llm-stats.com/benchmarks/terminal-bench-2.1), accessed 2026-07-19), and our throughput-unconstrained subsets pass at 85.7–95.9%. For frontier model-plus-harness systems, Terminal-Bench 2.1 has little discriminative headroom left — future comparisons will get more signal from a harder benchmark.

## Setup

| Dimension | Value |
| --- | --- |
| Benchmark | Terminal-Bench 2.1, revision `d49e28f1` (89 explicit task ids; 4 designated pilot tasks) |
| Model | `kimi-coding-plan` / `k3` |
| Thinking effort | `max` on both arms |
| Thinking retention | Aligned: prior-turn thinking is kept for subsequent requests (Maka: provider-native signed-thinking replay; Kimi Code: product default keep-all) |
| Agent time budget | Task-native agent timeout ×1 (48/89 tasks at 900 s; rest 600–12,000 s); 900 s outer setup/teardown grace |
| Repetitions | 1 |
| External `MAKA_SYSTEM_PROMPT` | Empty for both arms (see asymmetry 1 below) |
| Attempt policy | `single` for both arms; infrastructure-invalidated admissions excluded via the audited recovery layer |
| Maka arm | `maka_agent:MakaAgent`; host runtime LLM with tools bridged into the task container; continuation disabled; **context budget ON**: active + stale tool-result prune at 2048 estimated tokens, semantic compact off |
| Kimi Code arm | `kimi_code_agent:MakaKimiCodeAgent` 0.26.0 (official CLI, print mode, `stream-json`, `prompt-auto`) inside the container; **no Maka context-budget policy** |
| Pricing profile | Account-plan frozen at $0 recorded cost (token counts remain meaningful) |
| Concurrency | 2 task pairs, at most 4 concurrent arm attempts; A/B arms of a pair run on the same provider proxy path |

## Ruled out for the relative gap

- **Thinking effort and retention.** Both arms request max effort and both keep prior-turn thinking for multi-step tool loops. Do not read the gap as "Maka thinks harder" or "only one side keeps thinking history." Maka may show `reasoningTokens = 0` in usage projections while streaming thinking, and the Kimi proxy attributes a large share of output to reasoning — those are metering/projection differences, not misalignment.
- **Network.** Arms ran concurrently on the same degraded path, and wall-clock is essentially tied: mean ~1030 s vs ~1045 s, median ~753 s vs ~901 s, total ~25.5 h vs ~25.8 h, Maka lower on 65/89 tasks, deadline kills 28 vs 33. Network explains the absolute level, not the relative gap.
- **Maka heavy-task self-check.** The pinned build includes the headless heavy-task self-check machinery (plan/evidence tools plus a bounded finalization gate), but it is off by default and was not enabled here: no `--heavy-task` / `MAKA_HEAVY_TASK_MODE` in any of the 89 trial configs, an identical system-prompt hash across all 89 Maka cells, provider-visible tool count 7 on every completed cell (would be 11 with heavy-task tools), and zero self-check tool calls or gate events in any transcript. The +10.1 pp gap therefore cannot be attributed to Maka-side self-verification. Enabling heavy-task mode is a plausible follow-up lever on the "bad verification / incomplete deliverable / early stop" failure buckets.

## What differed: harness asymmetries

These are the main product/harness setting differences present in v11. They are listed as alignment gaps behind the +10.1 pp, **not** as a ranked causal chain — this run has no single-factor ablations. The gap persists among finished-in-time tasks (95.1% vs 85.7%), so it is not a differential-timeout artifact.

1. **Context-budget tool-result prune (Maka only — a primary harness setting).** Maka ran with active + stale tool-result prune at a 2048 estimated-token threshold (semantic compact off). Before each later model step, oversized *current-turn* tool results in the provider-visible message list are rewritten so they are not re-sent at full size. Kimi Code's print-mode path has **no** equivalent Maka context-budget policy and no structured prune meter in its transcripts. This is one of the largest intentional runtime-policy differences between the two arms.

   Measured on this run (completed cells only; aborted cells emit no prune diagnostics, so counts are a lower bound):
   - Policy ON: **89/89** Maka cells
   - Active prune diagnostics: **21/57** completed cells (**21/89** overall)
   - **576** active rewrite applications; **~1.87M** estimated tokens not re-sent in later steps (~4.4% of Maka cumulative input)
   - Stale prune recorded **0** events
   - Top savings: `video-processing` (~471k), `custom-memory-heap-crash` (~262k), `build-pov-ray` (~203k)
   - Final `contextRemaining` stayed above ~0.95M where measured — no overflow rescues observed under this decode/timeout regime
   - Among completed cells, pass rates with vs without prune diagnostics were essentially tied (20/21 vs 34/36); without a prune-off control, score impact is not estimated here. Treat prune as a **documented, live harness asymmetry**, not as a proven explanation of the +9 exclusive wins.

2. **System instructions.** Maka sends an empty system string. Kimi Code still bootstraps its product main-agent profile — ~20KB of interactive coding-agent instructions — regardless of the empty external env var.

3. **Tool surface and shell semantics.** Maka headless: narrow file/shell set with foreground Bash. Kimi Code print default: the full product tool list (tasks, cron, agent/swarm, plan/goal family, web) with product Bash/background behavior. The stock print path has no user-facing "minimal main tools" switch.

4. **Completion contract.** Kimi's product system steers toward telling the user when work is done or blocked; Maka relies on the task instruction plus tool schemas.

Background Bash is a real capability difference but not the score story: among the 12 Maka-exclusive passes, only two Kimi Code traces used `run_in_background` and one used `Task*` tools. Most exclusive failures look like ordinary foreground wrongness — bad verification, incomplete deliverable, early stop.

## Exclusive outcomes

**Maka only (12):** `build-pov-ray`, `configure-git-webserver`, `crack-7z-hash`, `financial-document-processor`, `fix-code-vulnerability`, `gpt2-codegolf`, `mcmc-sampling-stan`, `overfull-hbox`, `regex-chess`, `schemelike-metacircular-eval`, `torch-pipeline-parallelism`, `video-processing`

**Kimi Code only (3):** `feal-linear-cryptanalysis`, `mteb-retrieve`, `tune-mjcf`

The complete accepted pass/fail outcome for every task is in the adjacent [CSV](./terminal-bench-2.1-maka-vs-kimi-code-v11.csv); prompts, payloads, traces, and verifier output are not committed.

## Token economy

Recorded USD cost is **$0** for both arms under the frozen account-plan profile — an accounting placeholder, not an estimate of real cost; compare tokens, not dollars.

| Tokens over 88 metered pairs | Maka | Kimi Code |
| --- | ---: | ---: |
| Total | 43.96M | 47.77M |
| Cached input | 37.57M | 44.03M |
| Uncached input | 4.53M | 2.58M |
| Output | 1.86M | 1.16M |

Kimi Code's higher cached input is consistent with its larger product system surface and longer contexts, not a different effort setting. Maka's live tool-result prune (asymmetry 1) recorded ~1.87M estimated tokens not re-sent on completed cells — a lower-bound economy effect of that policy, not a bill delta.

Applying the official K3 API list prices ($0.30/MTok cache-hit input, $3.00/MTok cache-miss input, $15.00/MTok output) to the 88 metered pairs:

| List-price estimate | Maka | Kimi Code |
| --- | ---: | ---: |
| Cached input | $11.27 | $13.21 |
| Uncached input | $13.58 | $7.73 |
| Output | $27.87 | $17.47 |
| **Total** | **$52.72** | **$38.40** |
| Per task | $0.60 | $0.44 |
| Per accepted pass | $0.85 | $0.72 |

These are list-price equivalents of recorded usage, not actual charges — the run was metered at $0 under the subscription account plan. Maka used fewer total tokens yet costs more at list price because output tokens dominate the price sheet and it emitted 60% more of them; Kimi Code's advantage is its large, cheap cached input.

## Caveats

- One frozen run, `reps = 1`: descriptive, not statistical.
- The Kimi Code 53/89 headline depends on three operator-recorded verifier invalidations; the 50/89 first-verifier sensitivity is included so the adjustment is visible rather than implicit.
- This is a harness / product-agent comparison with a shared model, not a "same agent, same system, same tools" model bake-off. Empty external system env ≠ empty product system on Kimi Code.
- No single product dial was shown to explain the net +9; causes are separated into ruled-out vs asymmetric, not ranked.
- The projection against the official 88.3% rests on the finished-in-time subsets, which are enriched for shorter tasks and differ between arms; a healthy-network re-run is the decisive test.
- Missing oracle registry configuration: no oracle-backed disagreement layer.
- $0 recorded cost must not be read as free or equal economics; use the token table.
- Raw run artifacts remain local and git-excluded; this document commits only aggregate prose and the redaction-minimal outcome CSV.

## Integrity

SHA-256 of the frozen evidence files (local, git-excluded) and the committed CSV:

| Source | SHA-256 |
| --- | --- |
| `harness-ab-manifest.json` | `8ffe15ca48348b10aacde90b569c88b598bfd5bd961540fe77896566b8245258` |
| `harness-ab-report.json` | `83742970810c2ce864b35fba40180ebe41bdda28efe2f6954a376b3d04653269` |
| `controller/results.jsonl` | `a094d6096e7f5d519f10b65ff64984c46f561313eed8726f2aaefacdbb4270ce` |
| `controller/results.jsonl.attempts.jsonl` | `975222c4800d2cc65924116f423fc8ea7327b470de559eaefb6381319e9c209c` |
| Committed outcome CSV | `e7a2e76f883ab8672e72d347b66cf3392965b4e3e21fbac75eb4a9622af849c8` |

## Artifact pointers

| Artifact | Path |
| --- | --- |
| Harness report (JSON) | `~/.maka/eval/runs/k3-maka-vs-kimi-code-tbench-2.1-full-v11/harness-ab-report.json` |
| Harness report (Markdown) | `~/.maka/eval/runs/k3-maka-vs-kimi-code-tbench-2.1-full-v11/harness-ab-report.md` |
| Run manifest | `~/.maka/eval/runs/k3-maka-vs-kimi-code-tbench-2.1-full-v11/harness-ab-manifest.json` |
| Controller WAL (final + attempts) | `.../controller/results.jsonl`, `.../controller/results.jsonl.attempts.jsonl` |
| Per-request telemetry (Kimi Code arm) | `.../jobs/<run>/ab-kimi-code-r0-<task>/<task>/provider-request-telemetry.json` |
| Per-cell bridge output (both arms) | `.../jobs/<run>/ab-{maka\|kimi-code}-r0-<task>/<task>/trial/<trial>/agent/maka-cell-output.json` |
