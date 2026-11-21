---
name: run-train
description: Rigor Train skill for deep learning research repositories. Use when a documented or selected training command should be run conservatively for startup verification, short-run verification, full kickoff, or resume, with command, config, seed, log, checkpoint, status, and metric evidence written to standardized `train_outputs/`. Do not use for environment setup, exploratory sweeps, speculative idea implementation, or end-to-end orchestration.
---

# run-train

Use this as the Rigor Train skill. The installed slug remains `run-train` for
compatibility.

Use the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`; this skill should keep
training evidence bounded while leaving repository-specific monitoring details
to the model.

## When to apply

- When the training command has already been selected and should be executed conservatively.
- When the researcher wants startup verification, short-run verification, full training kickoff, or resume handling.
- When the run needs structured training status, checkpoint, and metric reporting.

## When not to apply

- When the main task is environment setup or asset download.
- When the researcher wants inference-only or evaluation-only execution.
- When the task is speculative exploration, multi-variant sweeps, or autonomous idea implementation.
- When the user still needs repository intake or paper gap resolution.

## Clear boundaries

- This skill executes a selected training command and normalizes the resulting evidence.
- It does not choose the overall research goal on its own.
- It does not own exploratory branching or speculative code adaptation.
- It should record partial, blocked, resumed, and kicked-off states clearly.
- It should preserve reproducibility context such as configs, seeds,
  checkpoints, logs, metrics, and runtime assumptions when available.

## Input expectations

- selected training goal
- runnable training command
- environment and asset assumptions
- run mode such as startup verification, short-run verification, full kickoff, or resume

## Output expectations

- `train_outputs/SUMMARY.md`
- `train_outputs/COMMANDS.md`
- `train_outputs/LOG.md`
- `train_outputs/SCIENTIFIC_CHANGELOG.md`
- `train_outputs/COMPARABILITY_REPORT.md`
- `train_outputs/status.json`

## Notes

Use `references/training-policy.md`, `../ai-research-reproduction/references/deep-learning-experiment-principles.md`, `scripts/run_training.py`, and `scripts/write_outputs.py`.
