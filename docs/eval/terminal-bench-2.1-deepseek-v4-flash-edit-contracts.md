# Terminal-Bench 2.1 — DeepSeek V4 Flash: three file-editing contracts in one harness

This report compares three file-editing tool contracts inside a single agent harness, on the same model, over the same Terminal-Bench 2.1 suite. Everything else is held fixed: the same DeepSeek Harness build, the same persistent-bash tool, the same system persona, the same deadline policy, the same executor. The only thing that moves between arms is how the model is allowed to change a file.

**Run id:** `edit-contracts-v1`, with three follow-up runs that re-ran cells the main run could not score

**Metric:** end-to-end pass@1 by the official task verifier

**Status:** `completed_with_gaps` — 86 of 89 tasks scored on all three arms

**Per-task outcomes:** [`terminal-bench-2.1-deepseek-v4-flash-edit-contracts.csv`](./terminal-bench-2.1-deepseek-v4-flash-edit-contracts.csv)

## TL;DR

- **`str_replace_editor` 56/86, `apply_patch` 56/86, `fs` 53/86, and this run had no power to separate them.** Exact McNemar gives p = 1.00, 0.63 and 0.65 — but the 95% intervals span roughly ±11 percentage points, so a real advantage of nine or ten tasks would have produced these same results. This is a failure to detect, not a finding of equivalence.
- **The minimum effect this design could detect is about 13 tasks.** Against the observed three-task spread its power is 7%. The arms disagree on **29 of 86 tasks (33.7%)**, which leaves each comparison only 17 to 22 informative pairs — and with no same-arm repetition, this run cannot say how much of that disagreement is variance and how much is a real per-task effect.
- **The arms fail differently even where their scores land close.** `fs` records nearly twice the verification failures of the baseline (13 against 7) and fewer deadline losses. It produces more answers and more of them are wrong. This too is underpowered, and it is the one difference large enough to be worth a targeted follow-up.
- **`fs` costs 13% more for three fewer passes**, at 30% more reasoning tokens. `str_replace_editor` and `apply_patch` are within 1% of each other on every economic measure.
- **The treatment is a tool family, not a diff format.** The arms differ in tool count, in tool-description length, and in whether guidance lives in the tool or the system prompt. `fs` presents the most tools and the *least* instruction text.

## What was held fixed and what varied

One harness build, one model, one composition, three plugin rows.

| | `str_replace_editor` (baseline) | `fs` | `apply_patch` |
| --- | --- | --- | --- |
| Editing plugin | `@deepseek-ai/dsh-tool-str-replace-editor` | `@deepseek-ai/dsh-tool-fs` | repo-authored V4A plugin |
| Model-facing tools | `bash`, `str_replace_editor` | `bash`, `edit`, `read`, `write` | `apply_patch`, `bash` |
| Tool descriptions | 4,730 chars | 1,096 chars | ~3,140 chars |
| Tool-contributed system prompt | none | 764 chars, 3 sections | none |
| Total instruction text | **4,730** | **1,860** | **3,140** |

The tool surfaces above were read back from the live runs' provider telemetry, not from the composition files, so they are what the model actually saw.

This asymmetry is the reason the treatment cannot be called "the edit contract" in the narrow sense. `fs` does not merely replace one tool with another: it splits reading, writing and editing into three tools, moves its guidance out of the tool description and into the system prompt, and ends up presenting 39% of the baseline's instruction text. Any difference this run measured is attributable to that whole package.

## Results

| Arm | Pass@1 | Passed / scored | Deadline exhausted | Exhausted but still passed | Verification failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| `str_replace_editor` | **65.1%** | 56 / 86 | 30 | 7 | 7 |
| `apply_patch` | **65.1%** | 56 / 86 | 27 | 6 | 9 |
| `fs` | **61.6%** | 53 / 86 | 28 | 8 | 13 |

Harbor raises its agent timeout and then runs the verifier anyway, so exhaustion and failure are two facts about a cell rather than two buckets. Between six and eight exhausted cells per arm still passed. A cell's failure class is therefore "exhausted and unscored" plus "verified and rejected", which is what the last two columns sum to.

## Pairwise comparison and what it can support

Exact two-sided McNemar over discordant task pairs, with the 86 scored tasks as the paired units. The chi-square form is not usable here — every comparison has fewer than 25 discordant pairs.

| Comparison | A-only | B-only | Discordant | Net difference | 95% CI | p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `str_replace_editor` vs `apply_patch` | 11 | 11 | 22 | +0.0 pp | −10.7 to +10.7 pp | 1.000 |
| `str_replace_editor` vs `fs` | 10 | 7 | 17 | +3.5 pp | −5.9 to +12.9 pp | 0.629 |
| `fs` vs `apply_patch` | 8 | 11 | 19 | −3.5 pp | −13.4 to +6.4 pp | 0.648 |

**No comparison reaches significance, and none of them licenses the conclusion that the contracts perform alike.** The intervals are the honest summary: each is about 22 percentage points wide, so every pair is equally consistent with no difference and with one arm being nine or ten tasks better. A p-value of 1.000 on the first row means the point estimate is exactly zero, not that the two contracts were shown to be equivalent.

### Power

The design's resolution can be stated directly. Given the discordant counts actually observed, the smallest split that would have reached p < 0.05 is:

| Discordant pairs | Split needed | Net tasks needed | Net observed |
| ---: | ---: | ---: | ---: |
| 17 | 13 : 4 | 9 | 3 |
| 19 | 15 : 4 | 11 | 3 |
| 22 | 17 : 5 | 12 | 0 |

And the power to detect a true effect, at the observed rate of 22 discordant pairs:

| True per-task advantage | Net tasks | Power |
| ---: | ---: | ---: |
| 60% of discordant tasks | +4.4 | 0.07 |
| 70% | +8.8 | 0.31 |
| 75% | +11.0 | 0.52 |
| 80% | +13.2 | 0.73 |
| 85% | +15.4 | 0.90 |

**This run could only reliably detect a difference of roughly 13 tasks or more.** Against differences of the size it actually observed — zero and three tasks — its power is between 3% and 7%. A study that would miss a real effect 93% of the time has not tested for one.

That is a property of the design, not of the contracts. Reaching adequate power for a three-task effect at this discordance rate needs repetitions in the hundreds of paired observations, which means repeated runs rather than a longer task list.

## The noise floor

| Outcome pattern (`str_replace_editor`, `fs`, `apply_patch`) | Tasks |
| --- | ---: |
| all three pass | 40 |
| all three fail | 17 |
| every other pattern | 29 |

**29 of 86 tasks (33.7%) came out differently on at least one arm.** The six discordant patterns are spread evenly, the largest being six tasks.

This number governs the rest of the report, because it is what leaves each comparison with only 17 to 22 paired observations that carry any information. It does not, by itself, say what the disagreement is made of. **This run cannot separate per-task variance from a genuine per-task contract effect, because it has no same-arm repetition.** An arm re-run against itself might disagree with itself on a similar fraction of tasks, or on far fewer; nothing here measures that. The one prior experiment on this suite that did repeat an identically configured arm saw 19% of its tasks flip between runs, which suggests much of this 33.7% is variance — but that was a different harness and is evidence by analogy, not by measurement.

Either way the consequence for this design is the same: at ~20 discordant pairs per comparison, an effect worth fewer than about a dozen tasks is not detectable. Fixing that needs repetitions, not a longer task list — and a same-arm repetition is the single cheapest addition, because it would also tell us which part of the 33.7% is noise.

## Where the arms actually differ

Close scores conceal unequal failure modes.

| Diagnostic | `str_replace_editor` | `fs` | `apply_patch` |
| --- | ---: | ---: | ---: |
| Verification failures | 7 | **13** | 9 |
| Requests per cell | 40.8 | 38.8 | 39.1 |
| Output tokens per request | 663 | **842** | 705 |
| Reasoning tokens, total | 1.57 M | **2.03 M** | 1.58 M |
| Median cell | 899 s | 786 s | **700 s** |
| Mean cell | 949 s | 930 s | 949 s |

`fs` takes slightly fewer steps and makes each one substantially larger: 27% more output per request and 30% more reasoning overall. It loses fewer cells to the deadline than the baseline and nearly doubles its verification failures. The shape is an arm that finishes more often and is wrong more often when it does.

`apply_patch` has the fastest median cell by 200 seconds against the baseline while landing on the identical score. Its mean matches the others exactly, so the gain is in the middle of the distribution, not in the tail.

None of these differences is significant on its own, and this run does not establish a cause for any of them. They are reported because they are the largest signals the run produced and the most economical things for a properly powered follow-up to target — not because the run tested them.

## Exclusive outcomes

Tasks one arm passed and both others failed, and the reverse:

| Arm | Won alone | Lost alone |
| --- | ---: | ---: |
| `str_replace_editor` | 5 | 5 |
| `fs` | 2 | 5 |
| `apply_patch` | 6 | 6 |

**`str_replace_editor` only:** `adaptive-rejection-sampler`, `cancel-async-tasks`, `crack-7z-hash`, `dna-insert`, `sanitize-git-repo`

**`fs` only:** `feal-linear-cryptanalysis`, `protein-assembly`

**`apply_patch` only:** `db-wal-recovery`, `mailman`, `make-mips-interpreter`, `model-extraction-relu-logits`, `overfull-hbox`, `regex-chess`

No task in any of these sets is obviously an editing task. The lists are consistent with noise and this run offers no evidence that they are anything else.

## Economics

| Arm | Total cost | Passed | Cost per pass | Input tokens | Cache-hit share | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `str_replace_editor` | $3.15 | 56 | **$0.0562** | 145.9 M | 98.40% | 2.33 M |
| `apply_patch` | $3.18 | 56 | $0.0568 | 149.4 M | 98.47% | 2.37 M |
| `fs` | $3.56 | 53 | $0.0671 | 160.3 M | 98.57% | 2.81 M |

The two two-tool arms are within 1% of each other on every column. `fs` spends 13% more in total and 19% more per pass, which follows directly from its larger responses rather than from more of them.

Costs are cache-aware API-equivalent estimates at DeepSeek's published V4 Flash prices as of 2026-08-17, applied to metered usage. That pricing is time-of-day dependent — peak hours (01:00–04:00 and 06:00–10:00 UTC) bill $0.44 per million cache-miss input tokens, $0.014 per million cache-hit input tokens and $1.32 per million output tokens, and all other hours bill half of that — so each cell's usage is apportioned across the two bands by the wall-clock overlap of its attempt window. This run spent 93% of its wall-clock off-peak. The figures are not a billing invoice, and they cover only the cells that landed in the final tally. The account was billed more, because the same machine also ran the discarded and aborted attempts described under [Operational findings](#operational-findings).

The harness's own `costUsd` field is not used here: at the time of the run it priced from a stale flat table ($0.14 miss / $0.0028 hit / $0.28 output), which understates the true spend by a factor of about 2.4 at this run's time-of-day mix. Every arm was priced from the same table, so the relative comparison above is unaffected by the choice; only the absolute level moves.

## Unscored tasks

Three of the 89 tasks are not in the tally.

| Task | Reason |
| --- | --- |
| `torch-pipeline-parallelism` | All three arms exhausted the 900 s agent budget (`exit 124`) in both the main run and a low-concurrency re-run. The verifier, which builds a fresh environment and downloads ~2.5 GB of CUDA wheels against the same 900 s wall, never produced a reward. |
| `torch-tensor-parallelism` | As above. |
| `kv-store-grpc` | `fs` and `apply_patch` completed; the baseline cell came back `indeterminate` (`external subject cancelled`). This is the one asymmetric exclusion in the run. |

The two torch tasks are a symmetric exclusion: the same wall bound every arm, in two runs, under two different concurrency settings. Their scores are missing rather than zero — an agent that ran out of budget may still have left a passing state behind, and only the verifier could have said so. `kv-store-grpc` is asymmetric and was not recovered; recovering it could have moved one arm's count by at most one, which no reading of the significance table would change.

## Operational findings

Four failures in this run were the harness's, not the model's. Each was reproduced on the host before being fixed, and each fix is in this branch.

**Native modules pin a glibc floor.** The toolchain was built on `node:22-bookworm`, and the resulting `pty.node` required `GLIBC_2.34`. Every task whose image is `debian:bullseye-slim` (glibc 2.31) failed at boot with `Failed to load native module: pty.node`, for all three arms — a whole symmetric cohort lost. Rebuilding on `node:22-bullseye` drops every native module in the tree to at most `GLIBC_2.28` (node-pty 2.28, koffi and sharp 2.17, node-addon-require-builtin 2.14) and carries the identical 22.23.2 interpreter. A benchmark toolchain's base image is a compatibility floor for the task images, not an implementation detail.

**A task instruction beginning with `-` was parsed as an option.** The harness CLI re-parses arguments after the first `--`, so an instruction like `-1 ...` needs two separators to survive. `pytorch-model-recovery` was the only affected task in this suite. The fix was verified to be inert elsewhere: for a normal task the outbound request is byte-identical with one separator and with two (3,632 bytes, `cmp` clean).

**`fs.inotify.max_user_instances` is a host-wide budget.** Its default of 128 is shared across every root-run container, and the harness's file watcher exhausts it above roughly 36 concurrent trials, surfacing as `EMFILE: too many open files, watch`. Raising it to 8,192 with `ulimit -n 262144` removed the failure class entirely; the full run recorded zero. Any host reproducing this run needs that setting before it needs more cores.

**Verifier bandwidth is a scheduling constraint, not just a timeout.** Four tasks in this suite build a fresh Python environment in the verifier and pull ~2.5 GB of CUDA wheels against a 900 s wall. At 96 concurrent trials they starved and returned no reward. The host sustains ~10 MB/s on one stream, so a single verifier fits comfortably and twelve do not. Re-running `pytorch-model-recovery` one arm at a time turned three unscored cells into three passes without changing anything else.

Two further fixes were made to the subject wrapper while diagnosing the above: the subject's stderr tail is now written to an artifact file rather than into the result frame, which has a 2 KiB payload cap, and a setup error is now reported to stderr instead of being swallowed by a frame that cannot carry it. The second of these immediately caught a temporal-dead-zone bug introduced by the first.

## Frozen setup

| Dimension | Value |
| --- | --- |
| Benchmark | Terminal-Bench 2.1, revision `d49e28f1e4ddd13d289e85a5f312a66750951932`; all 89 tasks |
| Model | `deepseek-v4-flash` on all three arms |
| Harness | DeepSeek Harness `@deepseek-ai/dsh` 0.1.0-rc.6, identical build on all three arms |
| Toolchain fingerprint | `sha256:04c77f754c07123176f036f8a29ad57da3b5f654dd66ab47ae291e05d08a3e62` (main run), `sha256:e748834fac1977038e297c498f496ab922c726261b666b57d0e20348bd8118bf` (bullseye rebuild, used for the five re-run tasks) |
| Executor | Harbor 0.20.0, Docker environment, containers deleted on exit |
| Repetitions | 1 |
| Metric | Paired pass@1 by the official verifier |
| Deadline policy | Task-native agent timeout ×1 |
| Placement | All three arms execute inside the task container |
| Concurrency | 32 task groups, 96 cells, on 56 vCPU and 256 GiB |
| Host | Tencent Cloud `S8.14XLARGE256`, Ubuntu, `fs.inotify.max_user_instances=8192`, `nofile` 262144 |
| Billing mode | Metered, using the DeepSeek V4 Flash pricing identity above |

The 96-cell ceiling is not a repository convention. The account's postpaid quota is 60 vCPU per zone, which fixes the largest instance available; 96 concurrent trials at the measured 2.7 GiB per trial is what that machine holds.

Five of the 89 tasks were scored by a follow-up run rather than the main run: `qemu-startup`, `qemu-alpine-ssh` and `mteb-retrieve` from a 6-concurrency repair run, and `pytorch-model-recovery` from three single-arm runs. Those cells used the bullseye toolchain and the two-separator argv; the other 84 tasks used the original build. Within every task all three arms shared one build, so the paired comparison is unaffected, but the stratification is real and is recorded per-cell in the CSV.

## Limitations

- **This run is underpowered for its own question.** One run, one repetition, ~20 discordant pairs per comparison. Its minimum detectable effect is about 13 tasks; the observed differences are zero and three. Every non-significant result here is a failure to detect, and none of them is evidence that the contracts are equivalent — testing that claim would need an equivalence test against a pre-stated margin, which this design cannot support either.
- The treatment is a tool family plus its guidance, not an isolated diff format. `fs` differs from the baseline in tool count, in instruction length, and in where the instructions live; no single-variable ablation was run.
- No arm was run against itself, so the 33.7% task-level disagreement cannot be decomposed into variance and contract effect. A same-arm repetition is the cheapest experiment that would make the rest of this data interpretable.
- Three tasks are unscored, one of them asymmetrically (`kv-store-grpc`).
- The two torch tasks are reported as unscored rather than as zeros. Treating them as zeros would be an inference about a verifier that never ran.
- Pairwise McNemar tests are reported without multiple-comparison correction. None approaches the uncorrected threshold, so correction would only widen intervals that are already too wide to conclude from.
- The confidence intervals use the Wald form for a paired difference in proportions. At these counts it is approximate; an exact interval would be somewhat wider, which strengthens rather than weakens the conclusion drawn from it.
- Cost figures are list-price estimates over metered usage for the landed cells only; they are not the account's spend for this experiment.
- Model conversation traces were not captured. The harness does not persist message history and the task containers are deleted on exit, so the archived evidence is per-cell results, verifier output, subject stderr and token accounting — not trajectories. Capturing trajectories would require the subject wrapper to record request and response bodies, and a re-run.
