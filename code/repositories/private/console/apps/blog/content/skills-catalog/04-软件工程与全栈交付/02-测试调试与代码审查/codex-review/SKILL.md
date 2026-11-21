---
name: codex-review
description: Cross-model code review using a different model family for a decorrelated second opinion on diffs. Catches blind spots that single-model review might miss. Use this skill when the user wants an independent second opinion on code changes.
allowed-tools:
  - Bash(echo *)
---

# Codex Review — Cross-Model Code Review

Perform code review using a different AI model family to catch blind spots and provide a decorrelated second opinion on code changes.

## When to Use

- Before merging a complex PR
- When a standard code review feels incomplete
- For security-critical changes that need extra scrutiny
- When the existing review tools miss context-specific issues

## Usage

Review uncommitted changes in the current branch:
```
/codex-review
```

Review specific scope:
```
/codex-review --scope uncommitted
/codex-review --branch main...feature-branch
/codex-review --commit abc123
```

## Benefits

1. **Different perspective** — different model family catches different issues
2. **Fresh eyes** — not biased by the original implementation context
3. **Complimentary** — works alongside built-in code-review for maximum coverage
