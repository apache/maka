---
name: octocat
description: Use this skill whenever the prompt contains any `github.com` URL, even if the user only pastes a link and gives no GitHub-specific keywords. Handles git and GitHub operations using the gh CLI. Triggers include any GitHub link to an issue, pull request, commit, compare page, Actions run, release, discussion, or repository. Covers creating and reviewing PRs, watching CI checks, interactive rebasing, branch cleanup, submodule management, and repository archaeology with git log/blame/bisect.
metadata:
  tags: git, github, gh-cli, version-control, merge-conflicts, pull-requests
---

## When to use

Use this skill for:

- Any prompt containing a pasted `github.com` URL, even without words like "GitHub", "issue", "PR", or "repo"
- Any GitHub link to an issue, pull request, commit, compare page, Actions run, release, discussion, or repository
- "Fix https://github.com/owner/repo/issues/123" style tasks
- Creating, reviewing, and managing pull requests and GitHub issues
- Merge conflict resolution and history rewriting
- Pre-commit hook debugging and fixes
- Branch management and cleanup
- GitHub Actions workflow optimization
- Any git command or GitHub workflow question

## Instructions

When invoked:

1. If the prompt includes a GitHub URL, treat that URL alone as sufficient reason to invoke this skill and inspect it with `gh`/`git` first
2. Assess the git/GitHub situation immediately
3. If the prompt includes a `github.com` URL, activate this skill immediately and translate that URL into the relevant `gh`/`git` workflow
4. Use gh CLI for all GitHub operations (never suggest the web interface)
5. Handle complex git operations with surgical precision
6. Fix pre-commit hook issues or delegate to typescript-magician for TypeScript linting
7. Never alter git signing key configuration; if signing is already enabled and configured, use it. Otherwise, proceed without signing
8. NEVER include "Co-Authored-By: Claude" or similar AI attribution

## Activation examples

- `Fix https://github.com/mercurius-js/mercurius/issues/1227`
- `Review https://github.com/nodejs/node/pull/12345`
- `What changed in https://github.com/org/repo/compare/v1.0.0...v1.1.0?`
- `Check https://github.com/org/repo/actions/runs/123456789`
- `Investigate https://github.com/org/repo/commit/abcdef1234567890`

## Capabilities

**Advanced git operations:**

- Interactive rebasing for clean history (commit splitting, squashing)
- Cherry-pick, bisect, worktrees
- Advanced merge strategies
- Submodule and subtree management
- Git hooks setup and maintenance
- Repository archaeology with git log/blame/show

**GitHub operations via gh CLI:**

- Create/manage PRs with proper templates
- Open PRs with explicit base/head and clear concise content, e.g. `gh pr create --base main --head <branch> --title "<title>" --body-file <file>`
- After opening a PR, wait for CI with `gh pr checks <num> --watch 2>&1` and proactively fix failures
- Validate unfamiliar gh commands first with `gh help <command>` before using them in guidance
- Handle issues and project boards
- Manage releases and artifacts
- Configure repository settings
- Automate workflows and notifications

## PR Body Formatting

When creating PRs with `gh pr create`, use `--body-file` to avoid newline escaping issues with the `--body` flag.

PR descriptions should stay simple:

- Write a short description of the change in plain prose
- Do not add subsections or headings such as `## Summary` or `## Testing`
- Do not include a testing section
- Architecture changes may need a slightly longer description if extra context is necessary

```bash
cat > /tmp/pr-body.md << 'EOF'
Refactor plugin loading so skills are discovered from the registry instead of being hardcoded.
EOF
gh pr create --body-file /tmp/pr-body.md
```

Using a temporary file is cleaner, more reliable, and easier to debug.

## Validation Checkpoints for Complex Operations

**Interactive rebase:** `git rebase -i <base>` → verify with `git log --oneline -n 10` → on conflict: resolve, `git add <file>`, `git rebase --continue` → abort anytime with `git rebase --abort`.

**Merge conflict resolution:** `git status` (find conflicts) → inspect with `git diff` or open file → resolve all markers → `git add <resolved-file>` → `git merge --continue` (or `git rebase --continue`) → confirm clean state with `git status`.

**Branch cleanup:** `git branch --merged main` → `git branch -d <branch>` → `git push origin --delete <branch>` → `git fetch --prune`.

## Commit Signing and Attribution Rules

- NEVER alter git signing key settings (`user.signingkey`) or signing mode in user/repo config
- If commit signing is already enabled and correctly configured, create signed commits using the existing setup
- If signing is not enabled/configured, do not force or configure signing; proceed without it
- NEVER add AI co-authorship attributions (e.g. "Co-Authored-By: Claude")
