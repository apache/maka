---
name: create-branch
description: Create a git branch following Sentry naming conventions. Use when asked to "create a branch", "new branch", "start a branch", "make a branch", "switch to a new branch", or when starting new work on the default branch.
argument-hint: "[optional description of the work]"
---

# Create Branch

Create a git branch following Sentry naming conventions.
Keep this workflow non-interactive unless the user explicitly asks to choose the name manually.

## Workflow

1. Resolve the work description:
   - If `$ARGUMENTS` is present, use it
   - Otherwise inspect:
     ```bash
     git diff
     git diff --cached
     git status --short
     ```
   - If there are local changes, derive a short description from the diff
   - If there are no local changes, use a generic description like `repo-maintenance`, `tooling-update`, or `work-in-progress`

2. Classify the branch type:

| Type      | Use when                                   |
| --------- | ------------------------------------------ |
| `feat`    | New functionality                          |
| `fix`     | Broken behavior now works                  |
| `ref`     | Behavior stays the same, structure changes |
| `chore`   | Maintenance of existing tooling/config     |
| `perf`    | Same behavior, faster                      |
| `style`   | Visual or formatting only                  |
| `docs`    | Documentation only                         |
| `test`    | Tests only                                 |
| `ci`      | CI/CD config                               |
| `build`   | Build system                               |
| `meta`    | Repo metadata                              |
| `license` | License changes                            |

When unsure: use `feat` for new things, `ref` for restructuring, `chore` for maintenance.

3. Generate `<type>/<short-description>`.
   Keep `<short-description>` kebab-case, ASCII-only, and ideally 3 to 6 words.

4. Choose the base without prompting:

   ```bash
   git branch --show-current
   git remote | grep -qx origin && echo origin || git remote | head -1
   git symbolic-ref refs/remotes/<remote>/HEAD 2>/dev/null | sed 's|refs/remotes/<remote>/||' | tr -d '[:space:]'
   ```
   - If default branch detection fails, fall back to `main`, then `master`, then the current branch
   - If on a detached HEAD, branch from the current commit
   - If already on a non-default branch, branch from the current branch
   - Only switch to the default branch when the user explicitly asks

5. Avoid collisions by appending `-2`, `-3`, and so on until the name is unused locally and remotely.

6. Create the branch:
   ```bash
   git checkout -b <branch-name>
   ```
   Report the final branch name, but do not stop for confirmation.

## References

- [Sentry Branch Naming](https://develop.sentry.dev/sdk/getting-started/standards/code-submission/#branch-naming)
