---
name: explore-code
description: Rigor Improve implementation leaf skill for auditable candidate implementation in deep learning research repositories. Use when the researcher explicitly authorizes exploratory work on an isolated branch or worktree to transplant modules, adapt a backbone, add LoRA or adapter layers, replace a head, or stitch together meaningful low-risk migration ideas with rollback-aware records in `explore_outputs/`. Do not use for end-to-end exploration orchestration on top of `current_research`, trusted baseline reproduction, conservative debugging, environment setup, verified contribution claims, or default repository analysis.
---

# explore-code

Use this as the Rigor Improve implementation leaf skill. The installed slug
remains `explore-code` for compatibility.

Use the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`; this skill should guide
bounded candidate code work without over-prescribing implementation details.

## When to apply

- When the researcher explicitly authorizes exploratory code changes on an isolated branch or worktree.
- When the task is source-anchored module transplant, backbone adaptation, LoRA or adapter insertion, or low-risk module combination.
- When summary-level recording is sufficient and the result is a candidate, not a trusted conclusion.

## When not to apply

- When the request is for trusted baseline work, conservative debugging, or normal training execution.
- When the user did not explicitly authorize exploratory modifications.
- When the task is a broad refactor or a from-scratch idea implementation.

## Clear boundaries

- This skill owns exploratory code modifications only.
- It must keep work isolated from the trusted baseline.
- Use `ai-research-explore` instead when the task spans both current_research coordination and exploratory runs.
- It may hand off execution to `minimal-run-and-audit` or `run-train`.
- It should favor source-anchored copying and minimal adaptation over freeform rewrites.
- It should record why a candidate change is meaningful, how to roll it back,
  and why it remains a candidate rather than a verified contribution.

## Output expectations

- `explore_outputs/CHANGESET.md`
- `explore_outputs/SCIENTIFIC_CHANGELOG.md`
- `explore_outputs/COMPARABILITY_REPORT.md`
- `explore_outputs/TOP_RUNS.md`
- `explore_outputs/status.json`

## Notes

Use `references/explore-policy.md`, `../ai-research-reproduction/references/research-rigor-principles.md`, `scripts/plan_code_changes.py`, and `scripts/write_outputs.py`.
