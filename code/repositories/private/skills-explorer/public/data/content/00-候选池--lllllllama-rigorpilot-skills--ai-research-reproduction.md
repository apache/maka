---
name: ai-research-reproduction
description: Rigor Reproduce compatible skill slug for README-first deep learning repository reproduction. Use when the user wants an end-to-end, minimal-trustworthy flow that reads the repository first, selects the smallest documented inference or evaluation target, coordinates intake, setup, trusted execution, optional trusted training, optional repository analysis, and optional paper-gap resolution, enforces conservative patch rules, records evidence assumptions deviations and human decision points, and writes the standardized `repro_outputs/` bundle. Do not use for paper summary, generic environment setup, isolated repo scanning, standalone command execution, silent protocol changes, score chasing, or broad research assistance outside repository-grounded reproduction.
compatibility: Requires Python 3.11+ and Git for bundled orchestration; target repositories may require additional reviewed dependencies, network access, or accelerators.
---

# ai-research-reproduction

## Purpose

Guide README-first deep learning reproduction toward the smallest trustworthy
run with auditable evidence. Preserve documented meaning; record assumptions,
deviations and blockers instead of changing semantics to manufacture success.
Load specialized references only for a concrete uncertainty.

## Fast Path

For a routine bounded run, keep the control path short:

1. Read the target README and only the target test/config/source needed to understand the documented command.
2. Run `scripts/orchestrate_repro.py --repo <repo> --plan-only --agent-output` with any explicit user timeout bound (`--timeout` or `--train-timeout`) already supplied; review `command_candidates`, the selected `cmd-XX`, side-effect contract, selection fingerprint, and returned `reviewed_run_args`. With no `--output-dir`, later evidence goes to `<repo>/repro_outputs` regardless of caller cwd.
3. Run the selected candidate, or another reviewed candidate, with `--run-selected --command-id <cmd-XX> --plan-fingerprint <fingerprint> --agent-output` plus requested timeout/metric/source-adjacent options. Preserve an explicit user command-timeout bound instead of silently making it stricter on a routine trusted run. `--timeout` limits the target command; do **not** wrap the whole orchestrator in an equal or shorter external timeout, because it still needs time to terminate children and write terminal evidence. A changed command set fails closed; setup/download commands are never target candidates.
4. Run `--verify-output --agent-output`; inspect detailed evidence files only when verification fails or the result is partial/blocked.
5. Deliver the bounded result and stop.

For a host with short tool-call deadlines, rerun planning with `--include-agent-handoff` and follow `references/agent-job.md`; otherwise keep the direct path above. Job completion is not task acceptance, and uncertain state is never a reason for automatic replay.

Do **not** inspect `orchestrate_repro.py`, `annotate_readme.py`, `_bundled/`, writers, or runtime internals on a normal success path. Inspect implementation only for a concrete blocker, unexpected side effect, bundle-integrity failure, or unresolved safety question. Use `scripts/doctor.py` for first-use environment/install diagnostics. Executed commands keep full lifecycle/log evidence under `repro_outputs/_runtime/<run_id>/`.

## Fit

Use this skill for repository-grounded, multi-phase trusted reproduction where
the goal is a small reproducible target. Do not use it for paper summaries,
generic setup, isolated scanning, standalone commands, open-ended research design,
or explicitly authorized candidate exploration.

## Trusted Target Selection

Choose the smallest target that can honestly demonstrate repository-grounded
reproduction:

1. documented inference
2. documented evaluation
3. documented training startup or partial verification
4. full training only after explicit user confirmation

Treat README guidance as the primary reproduction intent. Use repository files
to clarify the README, not to silently replace it. When the README and paper
conflict, record the conflict and use `paper-context-resolver` only for the
narrow reproduction-critical gap.

## Workflow

1. Treat README guidance as primary; extract and select the minimum trustworthy target.
2. Use setup/assets only for target-specific prerequisites and `analyze-project` only when structural clarification is needed.
3. Use `minimal-run-and-audit` for inference/evaluation/smoke and `run-train` for training startup, kickoff, or resume; direct execution is the default.
4. Pause before fuller training or changes to dataset, split, checkpoint, preprocessing, metric, loss, model semantics, or interpretation.
5. Award `result-match` only against explicit expected metrics and tolerance; process success alone is not reproduction success.
6. Write the evidence bundle, return the requested bounded result, and stop; optional stages are not automatic follow-up work.

## Patch Boundary

Prefer no repository edits. If edits are needed, keep them conservative and
auditable:

- Try command-line arguments, environment variables, path fixes, dependency
  version fixes, or dependency-file fixes before code changes.
- Reproduction fixes are allowed when needed, but they must not be hidden. State
  what changed, why it was necessary, whether it changes scientific meaning,
  and whether it affects comparability with the paper, README, or baseline.
- Avoid changing model architecture, core inference semantics, training logic,
  loss functions, or experiment meaning.
- If repository files must change, create a branch named
  `repro/YYYY-MM-DD-short-task`, keep verified patch commits sparse, and record
  README-fidelity impact in `PATCHES.md`.

See `references/patch-policy.md`.

## Outputs

Always target `repro_outputs/`:

```text
SUMMARY.md
COMMANDS.md
LOG.md
SCIENTIFIC_CHANGELOG.md
COMPARABILITY_REPORT.md
status.json
ANNOTATED_README.md   # original README + colored per-section agent-action annotations
PATCHES.md   # only if patches were applied
```

Use the templates under `assets/` and `references/output-spec.md`. Keep summaries
short, commands copyable, machine state stable, and scientific/comparability
changes explicit. `ANNOTATED_README.md` must preserve the source README byte-for-byte
outside inserted evidence blocks and pass its strip/check round trip. Use
`--source-adjacent-readme` only for an owned `RIGORPILOT_README.md`; never replace
an unrelated file. Distinguish verified facts from inference.

## Reference Loading

- Workflow judgment: `references/agent-operating-principles.md`.
- Human-readable output: `references/language-policy.md`.
- Scientific/comparability judgment: `references/research-rigor-principles.md` and, when experiment details matter, `references/deep-learning-experiment-principles.md`.
- Protocol-sensitive changes: `references/research-safety-principles.md` and `references/patch-policy.md`.
- Personal rigor and lessons are advisory only; keep specialized detail in references/scripts rather than expanding this entrypoint.
