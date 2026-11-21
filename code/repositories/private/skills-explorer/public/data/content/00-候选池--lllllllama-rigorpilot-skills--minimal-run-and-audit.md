---
name: minimal-run-and-audit
description: Rigor Run skill for README-first deep learning repo reproduction. Use when the task is specifically to capture or normalize evidence from the selected smoke test or documented inference or evaluation command and write standardized `repro_outputs/` files, including patch notes when repository files changed. Do not use for training execution, initial repo intake, generic environment setup, paper lookup, target selection, hidden scientific-meaning changes, or end-to-end orchestration by itself.
---

# minimal-run-and-audit

Use this as the Rigor Run skill. The installed slug remains
`minimal-run-and-audit` for compatibility.

Use the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`; this skill should make run
evidence auditable without turning every command into a rigid protocol.

## When to apply

- After a reproduction target and setup plan exist.
- When the main skill needs execution evidence and normalized outputs.
- When a smoke test, documented inference run, documented evaluation run, or other short non-training verification is appropriate.
- When the user already knows what command should be attempted and wants execution plus reporting only.

## When not to apply

- During initial repo scanning.
- When environment or assets are still undefined enough to make execution meaningless.
- When the task is a literature lookup rather than repository execution.
- When the user is still deciding which reproduction target should count as the main run.

## Clear boundaries

- This skill owns normalized reporting for an attempted command.
- It may receive execution evidence from the main skill or a thin helper.
- It does not choose the overall target on its own.
- It does not perform broad paper analysis.
- It does not own training startup, resume, or long-running training state.
- It should not normalize risky code edits into acceptable practice.
- It must not hide changes that alter evaluation, preprocessing, checkpoints,
  metrics, or other scientific meaning.

## Input expectations

- selected reproduction goal
- runnable commands or smoke commands
- environment and asset assumptions
- optional patch metadata

## Output expectations

- execution result summary
- standardized `repro_outputs/` files
- `SCIENTIFIC_CHANGELOG.md` for changed scientific meaning and evidence status
- `COMPARABILITY_REPORT.md` for README/paper/baseline comparability
- clear distinction between verified, partial, and blocked states
- `PATCHES.md` when repo files changed

## Notes

Use `references/reporting-policy.md`, `../ai-research-reproduction/references/research-rigor-principles.md`, `scripts/run_command.py`, and `scripts/write_outputs.py`.
