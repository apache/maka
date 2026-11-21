---
name: analyze-project
description: Rigor Analyze / Rigor Audit read-only skill for deep learning research repositories. Use when the user wants to read and understand a repository, inspect model structure and training or inference entrypoints, review configs and insertion points, or flag suspicious implementation patterns without modifying code or running heavy jobs. Do not use for active command execution, broad refactoring, speculative code adaptation, or automatic bug fixing.
---

# analyze-project

Use this as the Rigor Analyze / Rigor Audit read-only skill. The installed slug
remains `analyze-project` for compatibility.

Use the shared operating principles in
`../ai-research-reproduction/references/agent-operating-principles.md`; this skill should guide
read-only analysis without constraining the model's project-specific reasoning.

## When to apply

- The user wants to understand a deep learning repository before changing it.
- The user needs a map of model structure, training entrypoints, inference entrypoints, and config relationships.
- The user wants conservative suggestions about likely insertion points or suspicious implementation patterns.
- The user explicitly wants read-only analysis and not heavy execution.

## When not to apply

- When the main task is to execute a failing command or debug a traceback.
- When the user wants environment setup or asset download only.
- When the user wants speculative adaptation or broad exploratory patching.
- When the task is a general literature summary without repository analysis.

## Clear boundaries

- This skill is read-mostly.
- It may run lightweight static inspection helpers.
- It does not patch repository code.
- It does not own final reproduction outputs.
- It should mark suspicious patterns as heuristics, not confirmed bugs.

## Output expectations

- `analysis_outputs/SUMMARY.md`
- `analysis_outputs/RISKS.md`
- `analysis_outputs/status.json`

## Notes

Use `references/analysis-policy.md` and the shared `../ai-research-reproduction/references/research-pitfall-checklist.md`.
