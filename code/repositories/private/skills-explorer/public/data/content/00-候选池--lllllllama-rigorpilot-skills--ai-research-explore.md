---
name: ai-research-explore
description: Rigor Explore compatible skill slug for meaningful and potentially novel deep learning research candidates. Use when the researcher has chosen the task family, dataset, benchmark, evaluation method, provided SOTA references, and wants candidate-only exploration on top of `current_research` with auditable repo understanding, idea gating, fair comparison, and governed experiments written to `explore_outputs/`. Do not use for README-first trusted reproduction, open-ended direction finding, narrow code-only or run-only exploration, passive repo analysis, verified novelty claims, or implicit experimentation.
---

# ai-research-explore

## Purpose

Use this as the Rigor Explore compatible skill slug after the researcher
explicitly authorizes candidate-only work on top of a durable
`current_research` anchor. The installed slug remains `ai-research-explore` for
compatibility. Rigor Explore is for meaningful and potentially novel deep
learning research candidates while preserving scientific rigor, comparability,
reproducibility, and auditable collaboration. Novelty and significance remain
hypotheses before literature contrast, ablation evidence, and fair comparison.
The skill does not promise autonomous discovery, global benchmark completeness,
novelty proof, or trusted reproduction success.

Start from the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`, then load
`../ai-research-reproduction/references/research-rigor-principles.md` for research claims and
`../ai-research-reproduction/references/deep-learning-experiment-principles.md` when experiment
details affect comparability or reproducibility.

## Fit

Use this skill only when the request has both:

- Explicit exploration authorization such as candidate-only work, isolated
  branch or worktree, sweep, several variants, or exploratory ranking.
- A durable `current_research` context such as a branch, commit, checkpoint,
  run record, or already-trained local model state.

Keep narrow code-only requests on `explore-code`. Keep narrow run-only requests
on `explore-run`. Keep passive repository analysis on `analyze-project`. Keep
README-first reproduction on `ai-research-reproduction`.

## Research Rhythm

Use a two-loop rhythm:

- Outer loop: understand the repository, freeze task/dataset/evaluation/budget,
  preserve user ideas, map sources, gate ideas, and decide whether the next
  experiment is worth running.
- Inner loop: make one bounded candidate change or run, smoke-check it, collect
  evidence, rank it against the current anchor, and either stop or return to the
  outer loop with the new evidence.

This rhythm is a guide, not a rigid autonomous loop. Stop at explicit blockers,
unclear scientific meaning, exhausted budget, missing anchor/evaluation, or a
human checkpoint.

## Workflow

1. Confirm `current_research` and explicit explore-lane authorization.
2. Accept either legacy `variant_spec` or higher-level `research_campaign`.
3. In campaign mode, freeze the task, dataset, benchmark, evaluation source,
   SOTA reference, and budget before candidate work.
4. Build only the repo-understanding artifacts needed for the current campaign,
   usually through `analyze-project`.
5. Run bounded, cache-first source lookup when source support matters; prefer
   local curated literature such as Zotero if available, then seed sources,
   repo-local locators, public locators, or optional web lookup. Treat lookup as
   source resolution, not an open-ended literature search.
6. Preserve researcher-provided ideas, optionally add a small bounded set of
   single-variable seed ideas, and rank ideas with explicit gates and score
   breakdowns.
7. Prefer one clear candidate at a time. Use `explore-code` for bounded code
   adaptation and `explore-run` for short-cycle trials or sweeps.
8. Use `minimal-run-and-audit` or `run-train` only when the exploratory plan
   requires real execution evidence.
9. Write candidate-only outputs to `analysis_outputs/`, `sources/`, and
   `explore_outputs/` as appropriate; never present exploratory gains as trusted
   reproduction success. Include `SCIENTIFIC_CHANGELOG.md` and
   `COMPARABILITY_REPORT.md` for candidate scientific meaning and comparison
   boundaries.

## Ranking and Evidence

- Before execution, prioritize candidates by expected gain, cost, success
  likelihood, patch surface, dependency drag, evaluation risk, and rollback
  ease.
- After execution, rank by real evidence first: command status, observed
  metrics, artifacts, changed paths, smoke results, and reproducibility notes.
- Keep researcher-provided `evaluation_source` and `sota_reference` frozen for
  the campaign; do not claim they are globally complete.
- If the top ideas are too close or the implementation cannot be decomposed into
  auditable units, stop for a checkpoint instead of silently choosing.

## Campaign Inputs

`research_campaign` is preferred for Rigor Explore campaigns, but it should
stay minimal. The durable core is:

- `current_research`
- `task_family`
- `dataset`
- `benchmark`
- `evaluation_source`
- `sota_reference`
- `compute_budget`

Use `candidate_ideas`, `variant_spec`, `research_lookup`, `idea_policy`,
`idea_generation`, `source_constraints`, `feasibility_policy`, `baseline_gate`,
and `execution_policy` as optional guidance, not as fields the agent must fill
for every campaign. See `references/research-campaign-spec.md` for the advanced
schema and artifact expectations.

## Reference Loading

- Load `references/ai-research-explore-policy.md` for lane safety and candidate
  semantics.
- Load `references/research-campaign-spec.md` only when a campaign file is
  present or the user asks for Rigor Explore campaign governance.
- Load `../ai-research-reproduction/references/explore-variant-spec.md` for run-level variant matrix
  details.
- Load `../ai-research-reproduction/references/research-thinking-loop.md` before proposing or ranking candidate changes; it is the required greedy observe-ground-design-compare cycle.
- Load `../ai-research-reproduction/references/research-rigor-principles.md` before making novelty, contribution, SOTA, or comparability statements.
- Consult `~/.rigorpilot/PERSONAL_RIGOR.md` if present, under `../ai-research-reproduction/references/continuous-learning-policy.md` (advisory only; core wins).
- Load `../ai-research-reproduction/references/deep-learning-experiment-principles.md` when training,
  evaluation, baseline, ablation, metric, checkpoint, or dataset details matter.
- Use `scripts/orchestrate_explore.py` and `scripts/write_outputs.py` for the
  existing deterministic artifact workflow.
