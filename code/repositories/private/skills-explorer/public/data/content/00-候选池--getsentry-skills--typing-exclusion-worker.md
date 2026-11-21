---
name: typing-exclusion-worker
description: "Python typing exclusion worker: remove assigned mypy exclusion modules in small scoped batches, fix typing issues, run validation, and produce a structured completion summary. Use when running parallel typing-debt workers or when asked to remove modules from pyproject mypy exclusion overrides."
---

# Typing Exclusion Worker

## Purpose

Execute one assigned typing batch safely and predictably:

- remove only assigned modules from mypy exclusions,
- fix surfaced typing issues in scope,
- run required checks,
- return a consistent summary for the manager/orchestrator.

## Inputs Required

Before starting, confirm these inputs exist in the task prompt:

- worktree/branch name,
- exact module list to remove from exclusion,
- ownership/domain boundary,
- expected validation commands (if customized).

If any are missing, ask for them before editing.

## Scope Rules (Hard Constraints)

1. Only remove assigned module entries from the mypy exclusion list in `pyproject.toml`.
2. Keep code changes in assigned scope unless a direct dependency is required to pass typing/tests.
3. Do not expand to cross-team modules unless explicitly approved by the manager.
4. Avoid blanket `# type: ignore`; if unavoidable, use narrow `ignore[code]` with a short reason.

## Execution Workflow

1. **Apply exclusion change**

   - Remove assigned modules from the exclusion override in `pyproject.toml`.

2. **Run mypy on assigned scope**

   - Prefer targeted paths first for fast feedback.
   - Fix errors using explicit typing patterns (`isinstance` narrowing, accurate return types, typed class attrs, relation-safe model access).

3. **Run tests for touched area**

   - Execute targeted pytest for modified modules/tests.
   - Fix regressions before continuing.

4. **Run pre-commit on changed files**

   - Run `pre-commit run --files <changed files>`.
   - If hooks auto-fix files, rerun until clean.

5. **Final verification**
   - Re-run targeted mypy and tests after final edits.
   - Ensure no unrelated files were changed.

## Python Typing Best Practices

- Prefer precise types over `Any`.
- Use type narrowing on unions before attribute access.
- Keep method overrides signature-compatible with base classes.
- Annotate class attributes in tests/helpers when inference is weak.
- Use relation objects (`obj.related`) when stubs do not expose raw `*_id` attributes.

## Required Output Template

Return this exact structure at the end of each batch:

```markdown
## Batch Summary

- Branch/worktree: `<name>`
- Ownership/domain: `<team-or-domain>`

### Modules Removed From Exclusion

- `<module.path.one>`
- `<module.path.two>`

### Files Changed

- `<path>`
- `<path>`

### Key Typing Fixes

- `<short rationale + fix>`
- `<short rationale + fix>`

### Validation

- `mypy`: `<pass/fail + scope>`
- `pre-commit --files`: `<pass/fail>`
- `pytest`: `<pass/fail + scope>`

### Notes

- Remaining blockers: `<none or details>`
- Any new ignore entries: `<none or file + ignore code + reason>`
```

## Stop Conditions (Escalate to Manager)

Stop and report instead of widening scope when:

- fixes require touching another team/domain,
- exclusion conflicts in `pyproject.toml` cannot be resolved safely,
- error volume indicates batch is too large and should be split.
