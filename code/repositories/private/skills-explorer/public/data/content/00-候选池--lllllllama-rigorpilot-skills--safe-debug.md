---
name: safe-debug
description: Rigor Debug / Rigor Audit skill for deep learning research work. Use when the user pastes a traceback, terminal error, CUDA OOM, checkpoint load failure, shape mismatch, NaN loss symptom, or training failure and wants conservative diagnosis before any patching, with debug fixes clearly separated from research contributions. Do not use for broad refactoring, speculative adaptation, automatic exploratory patching, or general repository familiarization.
---

# safe-debug

Use this as the Rigor Debug / Rigor Audit skill. The installed slug remains
`safe-debug` for compatibility.

Use the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`; this skill should guide
conservative diagnosis without blocking the model from finding the local root
cause.

## When to apply

- The user provides a traceback, terminal error, or concrete training or inference failure symptom.
- The user wants diagnosis, root-cause narrowing, and minimal patch suggestions before code is changed.
- The user wants a safe debug flow with explicit human approval before mutation.

## When not to apply

- When the user wants a broad repository walkthrough without an active failure.
- When the task is speculative experimentation or code adaptation.
- When the user is asking for a large refactor or readability rewrite.

## Clear boundaries

- Diagnose first.
- Do not modify repository code by default.
- If a patch is needed, propose the smallest fix and require explicit approval first.
- Escalate savepoint or branch creation before medium-risk or high-risk changes.
- A debug fix is not automatically a research contribution; if it changes
  experiment meaning or comparability, say so explicitly.

## Output expectations

- `debug_outputs/DIAGNOSIS.md`
- `debug_outputs/PATCH_PLAN.md`
- `debug_outputs/status.json`

## Notes

Use `references/debug-policy.md`, `../ai-research-reproduction/references/research-rigor-principles.md`, and the shared `../ai-research-reproduction/references/research-pitfall-checklist.md`.
