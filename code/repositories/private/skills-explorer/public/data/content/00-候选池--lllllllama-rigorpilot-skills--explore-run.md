---
name: explore-run
description: Rigor Improve / Rigor Explore run leaf skill for bounded exploratory evidence in deep learning research repositories. Use when the researcher explicitly authorizes exploratory runs such as small-subset validation, short-cycle guess-and-check, batch sweeps, idle-GPU search, or quick transfer-learning trials, with fair-comparison caveats and no-overclaim summaries in `explore_outputs/`. Do not use for end-to-end exploration orchestration on top of `current_research`, trusted baseline execution, conservative training verification, default routing, verified SOTA claims, or implicit experimentation.
---

# explore-run

Use this as the Rigor Improve / Rigor Explore run leaf skill. The installed slug
remains `explore-run` for compatibility.

Use the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`; this skill should guide
candidate run planning while preserving model judgment about the active repo.

## When to apply

- When the researcher explicitly authorizes exploratory runs.
- When the task is a small-subset validation, short-cycle training probe, batch sweep, idle-GPU search, or quick transfer-learning trial.
- When the output should rank candidate runs rather than certify trusted success.

## When not to apply

- When the user wants trusted training execution or conservative verification.
- When there is no explicit exploratory authorization.
- When the task is repository setup, intake, or debugging.

## Clear boundaries

- This skill owns exploratory execution planning and summary only.
- Use `ai-research-explore` instead when the task spans both current_research coordination and exploratory code changes.
- It may hand off actual command execution to `minimal-run-and-audit` or `run-train`.
- It should keep experiment state isolated from the trusted baseline.
- It should prefer small-subset and short-cycle checks before heavier exploratory runs.
- It should label run results as bounded evidence and explain when a comparison
  is not directly fair.

## Ranking Semantics

- Pre-execution candidate selection uses three factors: `cost`, `success_rate`, and `expected_gain`.
- Default weights should stay conservative unless the researcher explicitly provides `selection_weights`.
- Budget pruning still applies after scoring through `max_variants` and `max_short_cycle_runs`.
- If runs are executed later, downstream ranking should switch to real execution evidence, not stay purely heuristic.

## Variant Spec Hints

- Use `variant_axes` to define the candidate dimension grid.
- Use `subset_sizes` and `short_run_steps` to express exploratory run scale.
- Use `selection_weights` to rebalance `cost`, `success_rate`, and `expected_gain`.
- Use `primary_metric` and `metric_goal` so downstream ranking can order executed candidates consistently.

## Output expectations

- `explore_outputs/CHANGESET.md`
- `explore_outputs/SCIENTIFIC_CHANGELOG.md`
- `explore_outputs/COMPARABILITY_REPORT.md`
- `explore_outputs/TOP_RUNS.md`
- `explore_outputs/status.json`

## Notes

Use `references/execution-policy.md`, `../ai-research-reproduction/references/explore-variant-spec.md`, `../ai-research-reproduction/references/deep-learning-experiment-principles.md`, `scripts/plan_variants.py`, and `scripts/write_outputs.py`.
