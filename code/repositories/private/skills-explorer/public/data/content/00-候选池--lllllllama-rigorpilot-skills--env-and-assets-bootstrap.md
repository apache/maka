---
name: env-and-assets-bootstrap
description: Rigor Setup skill for README-first deep learning repo reproduction. Use when the task is specifically to prepare a conservative conda-first environment, checkpoint and dataset path assumptions, cache location hints, and setup notes before any run on a README-documented repository. Do not use for repo scanning, full orchestration, paper interpretation, final run reporting, or generic environment setup that is not tied to a specific reproduction target.
---

# env-and-assets-bootstrap

Use this as the Rigor Setup skill. The installed slug remains
`env-and-assets-bootstrap` for compatibility.

Use the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`; this skill should keep setup
planning conservative while leaving environment-specific judgment to the model.

## When to apply

- After repo intake identifies a credible reproduction target.
- When environment creation or asset path preparation is needed before running commands.
- When the repo depends on checkpoints, datasets, or cache directories.
- When the user explicitly wants setup help before any run attempt.

## When not to apply

- When the repository already ships a ready-to-run environment that does not need translation.
- When the task is only to scan and plan.
- When the task is only to report results from commands that already ran.
- When the request is a generic conda or package-management question outside repo reproduction.

## Clear boundaries

- This skill prepares environment and asset assumptions.
- It does not own target selection.
- It does not own final reporting.
- It does not perform paper lookup except by forwarding gaps to the optional paper resolver.

## Input expectations

- target repo path
- selected reproduction goal
- relevant README setup steps
- any known OS or package constraints

## Output expectations

- conservative environment setup notes
- candidate conda commands
- asset path plan
- checkpoint and dataset source hints
- unresolved dependency or asset risks

## Notes

Use `references/env-policy.md`, `references/assets-policy.md`, `scripts/bootstrap_env.py`, `scripts/plan_setup.py`, and `scripts/prepare_assets.py`.
Use `scripts/bootstrap_env.sh` only as a POSIX wrapper around the Python bootstrapper when a shell entrypoint is more convenient.
